import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Zap } from 'lucide-react';
import { useMasterStore } from '../../stores/masterStore';
import { useEntriesStore } from '../../stores/entriesStore';
import { useI18n } from '../../i18n';
import { getUserData, setUserData } from '@/lib/userStorage';

interface ComboResult {
  stakeholder: string;
  projekt: string;
  taetigkeit: string;
  format: string;
  score: number;
  label: string;
}

interface FrecencyEntry {
  key: string; // stakeholder|projekt|taetigkeit|format
  count: number;
  lastUsed: number;
}

interface FuzzySearchProps {
  onSelect: (combo: { stakeholder: string; projekt: string; taetigkeit: string; format: string }) => void;
}

// Fuzzy match: does the option contain all characters of the query in order?
function fuzzyMatch(query: string, target: string): number {
  const q = query.toLowerCase();
  const t = target.toLowerCase();

  // Exact full match = highest
  if (t === q) return 120;
  // Exact prefix match
  if (t.startsWith(q)) return 100;
  // Contains match
  if (t.includes(q)) return 80;
  // Word boundary match (e.g. "meet" matches "team-meeting" at the "m" of "meeting")
  const wordBoundaryRe = new RegExp(`(?:^|[\\s\\-_\\.])${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i');
  if (wordBoundaryRe.test(t)) return 75;

  // Fuzzy char-by-char
  let qi = 0;
  let consecutive = 0;
  let maxConsecutive = 0;
  let prevMatch = -1;

  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      consecutive = (prevMatch === ti - 1) ? consecutive + 1 : 1;
      maxConsecutive = Math.max(maxConsecutive, consecutive);
      prevMatch = ti;
      qi++;
    }
  }

  if (qi < q.length) return 0; // Not all chars matched
  return 30 + maxConsecutive * 10;
}

type DimName = 'stakeholder' | 'project' | 'activity' | 'format';
interface DimMatch { name: string; score: number }

/**
 * Dimension-aware search: instead of O(n^4) brute force, each query word
 * is matched against each dimension independently. Words are assigned to
 * their best-matching dimension, then candidate combos are built only from
 * matched items — dramatically reducing the search space and improving
 * relevance.
 */
function searchCombos(
  query: string,
  stakeholders: string[],
  projects: string[],
  activities: string[],
  formats: string[],
  frecency: FrecencyEntry[]
): ComboResult[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const frecencyMap = new Map(frecency.map((f) => [f.key, f]));
  const now = Date.now();

  // Step 1: For each word, find top matches per dimension
  const dims: { key: DimName; items: string[] }[] = [
    { key: 'stakeholder', items: stakeholders },
    { key: 'project', items: projects },
    { key: 'activity', items: activities },
    { key: 'format', items: formats },
  ];

  // wordMatches[wordIdx][dimKey] = sorted list of matches
  const wordMatches: Record<DimName, DimMatch[]>[] = words.map((word) => {
    const perDim: Record<DimName, DimMatch[]> = {
      stakeholder: [], project: [], activity: [], format: [],
    };
    for (const dim of dims) {
      for (const item of dim.items) {
        const score = fuzzyMatch(word, item);
        if (score > 0) {
          perDim[dim.key].push({ name: item, score });
        }
      }
      perDim[dim.key].sort((a, b) => b.score - a.score);
      // Keep top 5 per dimension to limit combos
      perDim[dim.key] = perDim[dim.key].slice(0, 5);
    }
    return perDim;
  });

  // Step 2: Assign each word to its best dimension (greedy, no duplication)
  // Each word gets a "primary dimension" = the dimension where its top match scores highest
  const wordBestDim: { dim: DimName; score: number }[] = words.map((_, wi) => {
    let bestDim: DimName = 'stakeholder';
    let bestScore = 0;
    for (const dim of dims) {
      const topMatch = wordMatches[wi][dim.key][0];
      if (topMatch && topMatch.score > bestScore) {
        bestScore = topMatch.score;
        bestDim = dim.key;
      }
    }
    return { dim: bestDim, score: bestScore };
  });

  // If two words both want the same dimension, let the one with the higher score keep it,
  // and reassign the other to its next-best dimension
  const usedDims = new Set<DimName>();
  const wordAssignments: { dim: DimName; matches: DimMatch[] }[] = new Array(words.length);

  // Sort word indices by descending best score for greedy assignment
  const wordOrder = words.map((_, i) => i).sort((a, b) => wordBestDim[b].score - wordBestDim[a].score);

  for (const wi of wordOrder) {
    // Try dimensions in order of match quality for this word
    const dimsByScore = dims
      .map((d) => ({ key: d.key, topScore: wordMatches[wi][d.key][0]?.score || 0 }))
      .filter((d) => d.topScore > 0)
      .sort((a, b) => b.topScore - a.topScore);

    let assigned = false;
    for (const d of dimsByScore) {
      if (!usedDims.has(d.key)) {
        usedDims.add(d.key);
        wordAssignments[wi] = { dim: d.key, matches: wordMatches[wi][d.key] };
        assigned = true;
        break;
      }
    }
    // If all best dims are taken, allow sharing the dim (fallback)
    if (!assigned) {
      const fallback = dimsByScore[0];
      if (fallback) {
        wordAssignments[wi] = { dim: fallback.key, matches: wordMatches[wi][fallback.key] };
      } else {
        // Word matches nothing — no results possible
        return [];
      }
    }
  }

  // Step 3: Build candidate sets per dimension
  // For dimensions with an assigned word, use only those matched items
  // For dimensions without a word, use ALL items (or empty placeholder)
  const candidateSets: Record<DimName, string[]> = {
    stakeholder: stakeholders,
    project: projects,
    activity: ['', ...activities],
    format: ['', ...formats],
  };

  for (const wa of wordAssignments) {
    if (!wa) continue;
    const matchedNames = wa.matches.map((m) => m.name);
    if (wa.dim === 'activity') {
      candidateSets.activity = ['', ...matchedNames];
    } else if (wa.dim === 'format') {
      candidateSets.format = ['', ...matchedNames];
    } else {
      candidateSets[wa.dim] = matchedNames;
    }
  }

  // Step 4: Generate combos from the (now small) candidate sets
  const results: ComboResult[] = [];

  for (const sh of candidateSets.stakeholder) {
    for (const pr of candidateSets.project) {
      for (const act of candidateSets.activity) {
        for (const fmt of candidateSets.format) {
          // Re-score: each word must match at least one dimension in this combo
          let totalScore = 0;
          let allWordsMatch = true;

          for (const word of words) {
            const shScore = fuzzyMatch(word, sh);
            const prScore = fuzzyMatch(word, pr);
            const actScore = act ? fuzzyMatch(word, act) : 0;
            const fmtScore = fmt ? fuzzyMatch(word, fmt) : 0;
            const bestScore = Math.max(shScore, prScore, actScore, fmtScore);

            if (bestScore === 0) {
              allWordsMatch = false;
              break;
            }
            totalScore += bestScore;
          }

          if (!allWordsMatch) continue;

          // Frecency boost
          const key = `${sh}|${pr}|${act}|${fmt}`;
          const freq = frecencyMap.get(key);
          if (freq) {
            const recency = Math.max(0, 1 - (now - freq.lastUsed) / (14 * 24 * 60 * 60 * 1000));
            totalScore += freq.count * 5 + recency * 20;
          }

          // Bonus: prefer combos that fill more dimensions
          if (act) totalScore += 2;
          if (fmt) totalScore += 2;

          let label = act
            ? `${sh} · ${pr} · ${act}`
            : `${sh} · ${pr}`;
          if (fmt) label += ` (${fmt})`;

          results.push({ stakeholder: sh, projekt: pr, taetigkeit: act, format: fmt || 'Einzelarbeit', score: totalScore, label });
        }
      }
    }
  }

  // Sort by score descending, take top 8
  return results.sort((a, b) => b.score - a.score).slice(0, 8);
}

const FuzzySearch: React.FC<FuzzySearchProps> = ({ onSelect }) => {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();

  const { stakeholders, projects, activities, formats } = useMasterStore(); // NEW: add formats
  // entries store used indirectly via frecency tracking
  useEntriesStore();

  // Debounce search (100ms) — keeps UI responsive with large combo sets
  const updateDebouncedQuery = useCallback((val: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQuery(val), 100);
  }, []);

  // Load frecency data
  const frecency = useMemo(() => {
    return getUserData<FrecencyEntry[]>('frecency', []);
  }, []);

  // Top frecency combos for empty-state suggestions
  const topCombos = useMemo(() => {
    const freq = getUserData<FrecencyEntry[]>('frecency', []);
    return freq
      .sort((a, b) => b.count - a.count)
      .slice(0, 5)
      .map((f) => {
        const [sh, pr, act, fmt] = f.key.split('|'); // NEW: parse format
        let label = act ? `${sh} · ${pr} · ${act}` : `${sh} · ${pr}`;
        if (fmt) label += ` (${fmt})`; // NEW: show format in label
        return { stakeholder: sh, projekt: pr, taetigkeit: act || '', format: fmt || 'Einzelarbeit', label };
      });
  }, []);

  // Search results (uses debounced query for performance)
  const results = useMemo(() => {
    if (!debouncedQuery.trim()) return [];
    return searchCombos(debouncedQuery, stakeholders, projects, activities, formats, frecency); // NEW: pass formats
  }, [debouncedQuery, stakeholders, projects, activities, formats, frecency]);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [isOpen]);

  // Global key listener: start typing anywhere to search (ghost keyboard)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Ignore if already in an input/textarea/select
      const tag = (e.target as HTMLElement).tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      // Ignore modifier keys and navigation keys
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Only printable characters (single char keys)
      if (e.key.length === 1 && !e.repeat) {
        // Check if our container is visible (timer view is active)
        if (!containerRef.current || containerRef.current.offsetParent === null) return;
        setIsOpen(true);
        setQuery((prev) => {
          const next = prev + e.key;
          updateDebouncedQuery(next);
          return next;
        });
        inputRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [updateDebouncedQuery]);

  const handleSelect = (combo: { stakeholder: string; projekt: string; taetigkeit: string; format: string }) => {
    // Update frecency
    const key = `${combo.stakeholder}|${combo.projekt}|${combo.taetigkeit}|${combo.format}`; // NEW: include format
    const freq = getUserData<FrecencyEntry[]>('frecency', []);
    const existing = freq.find((f) => f.key === key);
    if (existing) {
      existing.count += 1;
      existing.lastUsed = Date.now();
    } else {
      freq.push({ key, count: 1, lastUsed: Date.now() });
    }
    // Keep max 100 entries
    freq.sort((a, b) => b.count - a.count);
    setUserData('frecency', freq.slice(0, 100));

    onSelect(combo);
    setQuery('');
    setIsOpen(false);
    setSelectedIndex(0);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    const items = results.length > 0 ? results : topCombos;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.min(prev + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex((prev) => Math.max(prev - 1, 0));
    } else if (e.key === 'Enter' && items.length > 0) {
      e.preventDefault();
      const selected = items[selectedIndex];
      if (selected) handleSelect(selected);
    } else if (e.key === 'Escape') {
      setIsOpen(false);
      setQuery('');
    }
  };

  const showResults = isOpen && (results.length > 0 || (query.trim() === '' && topCombos.length > 0));
  const showNoResults = isOpen && query.trim() !== '' && results.length === 0;

  return (
    <div ref={containerRef} style={{ position: 'relative' }}>
      {/* Search bar */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
          padding: '10px 16px',
          borderRadius: '12px',
          border: `1.5px solid ${isOpen ? 'rgba(201,169,98,0.25)' : 'var(--border)'}`,
          background: isOpen ? 'rgba(201,169,98,0.03)' : 'rgba(255,255,255,0.02)',
          backdropFilter: 'blur(8px)',
          transition: 'all 0.25s',
        }}
      >
        <span style={{ fontSize: '14px', opacity: isOpen ? 0.8 : 0.3, transition: 'opacity 0.2s' }}>⚡</span>
        <input
          id="fuzzy-search"
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            updateDebouncedQuery(e.target.value);
            setIsOpen(true);
            setSelectedIndex(0);
          }}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={t('stack.searchPlaceholder')}
          style={{
            flex: 1,
            border: 'none',
            background: 'transparent',
            color: 'var(--text)',
            fontSize: '13px',
            outline: 'none',
            fontFamily: 'var(--font)',
          }}
          aria-label={t('stack.searchPlaceholder')}
        />
        {query && (
          <button
            onClick={() => { setQuery(''); setIsOpen(false); }}
            style={{
              border: 'none',
              background: 'transparent',
              color: 'var(--text-muted)',
              cursor: 'pointer',
              fontSize: '14px',
              padding: '0 4px',
            }}
          >
            ✕
          </button>
        )}
      </div>

      {/* No results */}
      {showNoResults && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: '4px',
            background: 'var(--surface-solid, #1a1a2e)',
            border: '1px solid var(--border)',
            borderRadius: '12px',
            boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
            zIndex: 50,
            padding: '12px 16px',
          }}
        >
          <div style={{ color: 'var(--text-muted)', fontSize: '12px', textAlign: 'center' }}>
            {t('stack.noResults') || 'Keine Treffer'}
          </div>
          <div style={{ color: 'var(--text-muted)', fontSize: '10px', textAlign: 'center', marginTop: '4px', opacity: 0.6 }}>
            {t('stack.searchHint') || 'Tipp: Stakeholder + Projekt + Tätigkeit'}
          </div>
        </div>
      )}

      {/* Results dropdown */}
      {showResults && (
        <div
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            right: 0,
            marginTop: '4px',
            background: 'var(--surface-solid, #1a1a2e)',
            border: '1px solid var(--border)',
            borderRadius: '12px',
            boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
            zIndex: 50,
            overflow: 'hidden',
          }}
        >
          {/* Header */}
          {query === '' && topCombos.length > 0 && (
            <div style={{
              padding: '6px 12px',
              fontSize: '10px',
              fontWeight: 700,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              color: 'var(--text-muted)',
              borderBottom: '1px solid var(--border)',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
            }}>
              <Zap className="w-3 h-3" /> {t('stack.frequent')}
            </div>
          )}

          {/* Items */}
          {(results.length > 0 ? results : topCombos).map((item, idx) => (
            <button
              key={`${item.stakeholder}|${item.projekt}|${item.taetigkeit}|${item.format}`}
              onClick={() => handleSelect(item)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                width: '100%',
                padding: '8px 12px',
                border: 'none',
                background: idx === selectedIndex ? 'rgba(201,169,98,0.08)' : 'transparent',
                color: 'var(--text)',
                fontSize: '12px',
                textAlign: 'left',
                cursor: 'pointer',
                transition: 'background 0.1s',
              }}
              onMouseEnter={() => setSelectedIndex(idx)}
            >
              <div
                style={{
                  width: '6px',
                  height: '6px',
                  borderRadius: '50%',
                  background: idx === selectedIndex ? 'var(--neon-cyan)' : 'var(--border)',
                  flexShrink: 0,
                }}
              />
              <div style={{ flex: 1, display: 'flex', flexWrap: 'wrap', gap: '4px', alignItems: 'center' }}>
                <span style={{ padding: '1px 6px', borderRadius: '4px', background: 'rgba(110, 196, 158, 0.15)', color: 'rgba(110, 196, 158, 0.9)', fontSize: '10px', fontWeight: 600 }}>
                  {item.stakeholder}
                </span>
                <span style={{ padding: '1px 6px', borderRadius: '4px', background: 'rgba(100, 180, 255, 0.15)', color: 'rgba(100, 180, 255, 0.9)', fontSize: '10px', fontWeight: 600 }}>
                  {item.projekt}
                </span>
                {item.taetigkeit && (
                  <span style={{ padding: '1px 6px', borderRadius: '4px', background: 'rgba(201, 169, 98, 0.15)', color: 'rgba(201, 169, 98, 0.9)', fontSize: '10px', fontWeight: 600 }}>
                    {item.taetigkeit}
                  </span>
                )}
                {item.format && item.format !== 'Einzelarbeit' && (
                  <span style={{ padding: '1px 6px', borderRadius: '4px', background: 'rgba(180, 130, 220, 0.15)', color: 'rgba(180, 130, 220, 0.9)', fontSize: '10px', fontWeight: 600 }}>
                    {item.format}
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default FuzzySearch;

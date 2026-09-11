/**
 * Final score (spec §7.6).
 *
 * Reported as a percentage of achievable points rather than a raw total, so
 * scores stay comparable across songs of different lengths — and, in V2, across
 * players who may have had different numbers of valid checkpoints.
 */

import type { Rating } from '../pose/types';
import type { ScoreTotals } from '../scoring/engine';

const ORDER: readonly Rating[] = ['Perfect', 'Good', 'OK', 'Oops'];
const TONE: Record<Rating, string> = {
  Perfect: 'perfect',
  Good: 'good',
  OK: 'ok',
  Oops: 'oops',
};

function verdict(percent: number): string {
  if (percent >= 90) return 'Superstar';
  if (percent >= 75) return 'Great moves';
  if (percent >= 55) return 'Getting there';
  if (percent >= 30) return 'Keep practising';
  return 'That was… something';
}

export interface ResultsScreenProps {
  totals: ScoreTotals;
  title: string;
  onPlayAgain(): void;
  onNewSong(): void;
}

export function ResultsScreen({ totals, title, onPlayAgain, onNewSong }: ResultsScreenProps) {
  const scored = ORDER.reduce((sum, rating) => sum + totals.counts[rating], 0);

  return (
    <div className="screen results">
      <header className="screen-header">
        <p className="subtle">{title}</p>
        <h1>{verdict(totals.percent)}</h1>
      </header>

      <div className="final-score">
        <span className="final-percent">{totals.percent.toFixed(0)}</span>
        <span className="final-unit">%</span>
      </div>

      <div className="breakdown">
        {ORDER.map((rating) => (
          <div key={rating} className={`breakdown-row ${TONE[rating]}`}>
            <span className="breakdown-rating">{rating}</span>
            <span className="breakdown-count">{totals.counts[rating]}</span>
          </div>
        ))}
      </div>

      <p className="subtle note">
        {scored} checkpoints scored
        {totals.skipped > 0 && (
          <>
            {' · '}
            {totals.skipped} skipped where you weren’t detected — these don’t count against you
          </>
        )}
      </p>

      <div className="actions">
        <button className="ghost" onClick={onNewSong}>
          Different song
        </button>
        <button className="primary" onClick={onPlayAgain}>
          Dance again
        </button>
      </div>
    </div>
  );
}

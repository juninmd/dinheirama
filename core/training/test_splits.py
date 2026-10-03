import unittest
from datetime import date, timedelta

from splits import missing_classes, temporal_purged_split


def make_timestamps(days=100, per_day=3):
    start = date(2025, 1, 1)
    out = []
    for d in range(days):
        for _ in range(per_day):
            out.append((start + timedelta(days=d)).isoformat() + 'T12:00:00.000Z')
    return out


class TemporalPurgedSplitTest(unittest.TestCase):
    def test_validation_is_strictly_after_training(self):
        ts = make_timestamps()
        train, val = temporal_purged_split(ts, test_size=0.2, horizon_days=5)
        self.assertLess(max(ts[i] for i in train), min(ts[i] for i in val))

    def test_labels_of_training_do_not_reach_validation(self):
        ts = make_timestamps()
        train, val = temporal_purged_split(ts, test_size=0.2, horizon_days=5)
        first_val = date.fromisoformat(min(ts[i] for i in val)[:10])
        last_train = date.fromisoformat(max(ts[i] for i in train)[:10])
        # rotulo de 5 pregoes ~ 7 dias corridos: o ultimo treino precisa terminar antes da validacao
        self.assertLess(last_train + timedelta(days=7), first_val)

    def test_all_tickers_on_same_date_stay_together(self):
        ts = make_timestamps(per_day=5)
        train, val = temporal_purged_split(ts)
        train_days = {ts[i][:10] for i in train}
        val_days = {ts[i][:10] for i in val}
        self.assertTrue(train_days.isdisjoint(val_days))

    def test_roughly_respects_test_size(self):
        ts = make_timestamps(days=200)
        _, val = temporal_purged_split(ts, test_size=0.25)
        self.assertAlmostEqual(len(val) / len(ts), 0.25, delta=0.02)

    def test_too_few_dates_raises(self):
        with self.assertRaises(ValueError):
            temporal_purged_split(make_timestamps(days=3))


class MissingClassesTest(unittest.TestCase):
    def test_reports_absent_classes(self):
        self.assertEqual(missing_classes([1, 2, 2, 1]), [0])
        self.assertEqual(missing_classes([0, 1, 2]), [])
        self.assertEqual(missing_classes([]), [0, 1, 2])


if __name__ == '__main__':
    unittest.main()

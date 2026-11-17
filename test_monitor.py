import os
import tempfile
import unittest
from monitor import DeduplicationStore, extract_referrals, TelegramNotifier


class TestReferralMonitor(unittest.TestCase):
    def test_extract_referrals_and_normalization(self):
        sample_text = """
        Hey everyone! Grab my fresh Claude Pro trial here:
        https://www.claude.ai/referral/AbCdEf123456!
        Duplicate in same post: https://claude.ai/invite/abcdef123456
        And an Anthropic invite: https://anthropic.com/invite/XyZ_98765
        """
        matches = extract_referrals(
            sample_text,
            title="Free Claude Pro Trials Megathread",
            permalink="https://www.reddit.com/r/ClaudeAI/comments/xyz",
        )
        # Should deduplicate case-insensitively within the same batch
        self.assertEqual(len(matches), 2)
        self.assertEqual(matches[0].url, "https://claude.ai/referral/AbCdEf123456")
        self.assertEqual(matches[0].code, "Claude Referral / Trial:abcdef123456")
        self.assertEqual(matches[1].url, "https://www.anthropic.com/invite/XyZ_98765")

    def test_sqlite_atomic_deduplication(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            db_file = os.path.join(tmpdir, "test_referrals.db")
            store = DeduplicationStore(db_file)
            matches = extract_referrals(
                "Check https://claude.ai/referral/UniqueCode99",
                "Test Title",
                "https://reddit.com/r/test",
            )
            self.assertEqual(len(matches), 1)
            item = matches[0]

            # First insertion must return True
            self.assertTrue(store.is_new_and_mark(item))
            # Second insertion of same code must return False
            self.assertFalse(store.is_new_and_mark(item))
            self.assertEqual(store.count(), 1)
            store.close()

    def test_telegram_markdown_escaping(self):
        escaped = TelegramNotifier._escape_md("Claude Pro (Trial) - Free! [Link]")
        self.assertIn(r"\(Trial\)", escaped)
        self.assertIn(r"\!", escaped)


if __name__ == "__main__":
    unittest.main()

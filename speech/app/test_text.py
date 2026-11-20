"""pause_dashes: run with `npm run test:speech` (stdlib only)."""
import unittest

from text import pause_dashes


class PauseDashes(unittest.TestCase):
    def test_a_dash_between_words_is_a_comma(self):
        self.assertEqual(pause_dashes("I checked the inbox—nothing new from Alex."), "I checked the inbox, nothing new from Alex.")
        self.assertEqual(pause_dashes("The plan — if it works — ships Friday."), "The plan, if it works, ships Friday.")
        self.assertEqual(pause_dashes("It rained -- a lot."), "It rained, a lot.")
        self.assertEqual(pause_dashes("A – B"), "A, B")
        self.assertEqual(pause_dashes("Tokyo is 15°—clear skies."), "Tokyo is 15°, clear skies.")

    def test_a_dash_that_ends_a_sentence_or_quote_is_a_stop(self):
        self.assertEqual(pause_dashes("Wait—"), "Wait…")
        self.assertEqual(pause_dashes("He said “I was going to—” and stopped."), "He said “I was going to…” and stopped.")
        self.assertEqual(pause_dashes("Really—?"), "Really?")
        self.assertEqual(pause_dashes("Yes,— no."), "Yes, no.")

    def test_ranges_and_pairings_keep_a_hyphen(self):
        self.assertEqual(pause_dashes("pages 3–5"), "pages 3-5")
        self.assertEqual(pause_dashes("2020–2024"), "2020-2024")
        self.assertEqual(pause_dashes("the Paris–London flight"), "the Paris-London flight")

    def test_other_text_is_untouched(self):
        for t in ["well-known", "9:00-10:30", "one, two; three", "", "Hello."]:
            self.assertEqual(pause_dashes(t), t)
        self.assertEqual(pause_dashes("— Hello"), "Hello")


if __name__ == "__main__":
    unittest.main()

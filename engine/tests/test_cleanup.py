import pytest

from echoflow_engine import cleanup
from echoflow_engine.cleanup import rule_clean, resolve_style
from echoflow_engine.verify import facts_preserved

D = {"terms": [], "replacements": {}}


def test_fillers_removed():
    assert rule_clean("um so I think uh we should go", "clean", D) == "So I think we should go."


def test_stutter_collapsed():
    assert rule_clean("send the the report", "clean", D) == "Send the report."


def test_self_correction_single_word():
    assert rule_clean("let's meet on Tuesday, no, Wednesday", "clean", D) == "Let's meet on Wednesday."


def test_self_correction_number():
    assert rule_clean("the call is at 3, no, 4 pm", "clean", D) == "The call is at 4 pm."


def test_self_correction_i_mean_with_preposition():
    out = rule_clean("I'll be at the office, I mean at home tonight", "clean", D)
    assert out == "I'll be at home tonight."


def test_scratch_that_removes_previous_sentence():
    out = rule_clean("Buy eggs. Call mom. Scratch that. Call dad.", "clean", D)
    assert out == "Buy eggs. Call dad."


def test_no_false_correction_in_normal_sentence():
    assert rule_clean("I said no to the offer", "clean", D) == "I said no to the offer."


def test_spoken_commands():
    out = rule_clean("hello team new paragraph here is the plan new line first step", "clean", D)
    assert out == "Hello team\n\nHere is the plan\nFirst step."


def test_dictionary_replacements_and_terms():
    d = {"terms": ["Anthropic"], "replacements": {"claude code": "Claude Code"}}
    out = rule_clean("i use claude code at anthropic", "clean", d)
    assert out == "I use Claude Code at Anthropic."


def test_capitalization_and_punctuation():
    assert rule_clean("i think i am done", "clean", D) == "I think I am done."


def test_bullets_and_todo_styles():
    assert rule_clean("Buy milk. Call Sam. Book flights.", "bullets", D) == "- Buy milk.\n- Call Sam.\n- Book flights."
    out = rule_clean("I need to buy milk. Remind me to call Sam.", "todo", D)
    assert out == "- [ ] Buy milk.\n- [ ] Call Sam."


def test_message_style_drops_final_period_on_single_sentence():
    assert rule_clean("sounds good see you then", "message", D) == "Sounds good see you then"


def test_resolve_style_from_app():
    s = {"style": "auto", "app_styles": {"gmail": "email", "slack": "message"}}
    assert resolve_style(s, "Gmail - Inbox - Chrome") == "email"
    assert resolve_style(s, "Slack") == "message"
    assert resolve_style(s, "Notepad") == "clean"
    assert resolve_style({**s, "style": "bullets"}, "Gmail") == "bullets"


# ---------------------------------------------------------------- verifier
def test_facts_preserved_accepts_rewording():
    raw = "Send 25 invoices to Sam Carter by March 5th"
    assert facts_preserved(raw, "Please send 25 invoices to Sam Carter by March 5th.")


def test_facts_rejects_dropped_number():
    assert not facts_preserved("Send 25 invoices to Sam", "Please send invoices to Sam.")


def test_facts_rejects_changed_number():
    assert not facts_preserved("The meeting is at 3 pm", "The meeting is at 4 pm.")


def test_facts_rejects_dropped_name():
    assert not facts_preserved("Tell Priya about the budget", "Tell her about the budget.")


def test_facts_number_words_equal_digits():
    assert facts_preserved("we need twenty five chairs", "We need 25 chairs.")
    assert facts_preserved("we need 25 chairs", "We need twenty-five chairs.")


def test_facts_ignores_sentence_start_capitals():
    assert facts_preserved("Okay so we should leave", "We should leave.")


# ---------------------------------------------------------------- orchestration with fake providers
class Fake:
    def __init__(self, out):
        self.out, self.name = out, "fake"

    def clean(self, raw, style, dictionary, app):
        return self.out


def run(provider_out, raw="send 25 invoices to Sam"):
    prov = Fake(provider_out) if provider_out != "RAISE" else None
    return cleanup.clean(raw, "clean", D, "App", provider=prov)


def test_provider_output_used_when_facts_hold():
    text, used, flags = run("Please send 25 invoices to Sam.")
    assert (text, used, flags) == ("Please send 25 invoices to Sam.", "fake", "")


def test_provider_unavailable_falls_back_with_flag():
    text, used, flags = run(None)
    assert text == "Send 25 invoices to Sam." and used == "rules" and flags == "fallback"


def test_provider_dropping_fact_is_rejected():
    text, used, flags = run("Please send the invoices to Sam.")
    assert text == "Send 25 invoices to Sam." and used == "rules" and flags == "fact-check"


def test_no_provider_is_plain_rules():
    text, used, flags = cleanup.clean("hello there", "clean", D, "App", provider=None)
    assert (used, flags) == ("rules", "")

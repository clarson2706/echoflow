"""Fills a data directory with sample entries, for screenshots and demos. Usage: python seed_demo.py DATA_DIR"""
import sys, time
from pathlib import Path
from echoflow_engine.db import Store

s = Store(Path(sys.argv[1]) / "echoflow.db")
now = time.time()
def add(minutes_ago, **kw):
    i = s.add_entry(**kw)
    s.db.execute("UPDATE entries SET created_at=? WHERE id=?", (now - minutes_ago * 60, i)); s.db.commit()

add(4, kind="dictation", app="Gmail", style="email", duration=11.2,
    raw="um hi Sam thanks for sending the deck over I had a look and the numbers on slide four look right can we move the call to Thursday at 3 no 4 pm",
    cleaned="Hi Sam,\n\nThanks for sending the deck over. I had a look and the numbers on slide four look right. Can we move the call to Thursday at 4 pm?")
add(19, kind="dictation", app="Claude", style="message", duration=7.4,
    raw="can you check why the export button is greyed out when there are no entries selected",
    cleaned="Can you check why the export button is greyed out when no entries are selected")
add(63, kind="dictation", app="VS Code", style="clean", duration=5.1,
    raw="remember to rename the settings table before the release and add a migration",
    cleaned="Remember to rename the settings table before the release and add a migration.")
add(95, kind="note", title="Marketing: positioning and the spring launch", style="lecture", duration=2538,
    raw="Today we covered positioning. A brand occupies a position in the customer's mind relative to competitors. The three steps are segment, target and position. The midterm is on March 5th and covers chapters one to six. We need to read the Dove case study before Thursday.",
    cleaned="# Marketing: positioning and the spring launch\n\n## Summary\nA lecture on positioning: how a brand takes a distinct place in the customer's mind relative to competitors, built through segmenting, targeting and positioning. The midterm is on March 5th.\n\n## Positioning\n- A brand occupies a position in the customer's mind relative to its competitors.\n- Three steps: segment the market, choose a target, then position against rivals.\n\n## Key points\n- The midterm is on March 5th and covers chapters one to six.\n\n## Action items\n- [ ] Read the Dove case study before Thursday.")
add(60*26, kind="dictation", app="Notion", style="todo", duration=9.9,
    raw="I need to book the venue and call Priya about the budget and send the invoices",
    cleaned="- [ ] Book the venue.\n- [ ] Call Priya about the budget.\n- [ ] Send the invoices.")
add(60*27, kind="dictation", app="Slack", style="message", duration=3.0,
    raw="sounds good see you at the standup", cleaned="Sounds good, see you at the standup")
add(60*52, kind="note", title="Launch planning with Priya", style="meeting", duration=1210,
    raw="We agreed the launch date is March 12th and the budget is 25000 dollars.",
    cleaned="# Launch planning with Priya\n\n## Summary\nAgreed the launch date and budget.\n\n## Decisions\n- Launch date is March 12th.\n- Budget is 25000 dollars.\n\n## Action items\n- [ ] Priya to confirm the venue by Friday.")
s.add_term("Priya"); s.add_term("EchoFlow"); s.add_replacement("e flow", "EchoFlow")
print("seeded")

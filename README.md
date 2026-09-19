# Paper Machine

**Draw a machine on paper. Photograph it. Watch it run.**

Paper Machine turns a hand-drawn diagram into a live, executable state machine. You sketch
states and arrows on paper the way you would on a whiteboard, point a camera at it, and the
drawing becomes a running program you can interact with — fire events, watch a token travel
along the arrows you drew, see which state you land in.

Gemini is the compiler. It does not describe the picture; it reads the shapes, follows the
arrowheads, recovers the handwritten labels, and emits the structured graph that the app
executes.

## The problem

Designers, students and engineers sketch state machines and flowcharts on paper constantly —
it is the fastest way to think. But a sketch is dead on arrival. To actually *test* the logic
you drew, you have to abandon the paper and retype the whole thing into a modelling tool,
which is slow enough that most people never do it. So logic errors survive until they become
code, and the paper gets thrown away.

Paper Machine removes the retyping step entirely. The paper *is* the source code.

## How Gemini is used in the interaction loop

The loop is: **draw on paper → photograph → Gemini compiles → the graph executes → you
interact with it → redraw and re-scan.**

Gemini sits at the only step that cannot be done any other way. From a single photograph it
must simultaneously:

1. **Detect shapes and classify them semantically.** A diamond is a decision, a double circle
   is an accept state, a filled entry dot marks the start. This is the difference between an
   image and a program.
2. **Follow arrow direction.** Transition direction is carried entirely by a hand-drawn
   arrowhead, often on a curved or crossing line. Getting this backwards produces a machine
   that runs wrong rather than one that fails loudly.
3. **Read handwriting in context.** Arrow labels are events (`coin`, `push`, `timeout`) and
   are bound to specific edges, not floating text.
4. **Recover spatial layout.** Gemini returns normalized x/y for every node, so the rendered
   machine resembles what was actually drawn. This is what makes the result feel like *your*
   drawing came alive instead of being replaced by a generic auto-layout.
5. **Report its own uncertainty.** The prompt requires a `warnings` array for anything it had
   to guess, which the UI shows rather than hides.

Remove Gemini and there is no project. There is no OCR-plus-heuristics path to "which shape
does this arrowhead point at, and is that shape a decision or a state" that works on a phone
photo of messy handwriting in a few hours.

Gemini is called exactly once per scan, with the photo bytes and a schema-constrained prompt,
at `temperature=0.1`. Everything after that — layout, animation, execution — is deterministic
local code. See `SKILL.md` for the call pattern and `normalize()` in `app.py` for the
structural contract that makes model output safe to execute.

## Interface

The input is a piece of paper and a camera. The output is a running program.

There is no text box in which you type the machine. You cannot describe an arrowhead with a
keyboard faster than you can draw one, and the spatial arrangement of a diagram — which is
most of its meaning — has no keyboard representation at all. Editing the machine means
editing the paper and scanning again.

## Running it

```bash
git clone <this repo> && cd paper-machine
python3 -m venv .venv && ./.venv/bin/pip install -r requirements.txt
cp .env.example .env        # then paste your key from https://mlh.link/gemini
./.venv/bin/python app.py
```

Open <http://localhost:5001>. Click **Load sample** to see the executor run without a key.

Camera capture needs a secure context: `localhost` works on a laptop; to use a phone camera,
tunnel it (`ngrok http 5001`) or just use **Upload photo**, which works everywhere.

## Drawing tips

- Dark pen, white unlined paper, fill the frame with the drawing.
- Circles or boxes for states, diamonds for decisions, a double circle for an end state.
- Mark the start with a small arrow coming from nothing, or write "start".
- Write the event *on* the arrow, not beside a different one.
- Self-loops (an arrow from a shape back to itself) are supported and render correctly.

## Tech

- **Gemini API** (`google-genai`) — vision compilation of the drawing into a structured graph
- **Google Antigravity** — the project was scaffolded and iterated in Antigravity, with
  `SKILL.md` giving the agent the Gemini call pattern
- **Flask** (Python 3.13) — serves the app, holds the API key server-side, one `/api/compile`
  endpoint
- **Vanilla JS + Canvas 2D** — graph layout, bezier edge routing with parallel-edge fanning
  and self-loops, token animation, the state machine executor
- **Tailwind CSS** (CDN) — interface
- **MediaDevices `getUserMedia`** — in-browser camera capture

No database, no build step.

## Surviving a saturated API

During the event the Gemini API was heavily contended — `503 high demand` on most models,
in bursts. Naively walking a fallback list one model at a time took **52 seconds** per
compile, which is unusable when someone is watching.

Two observations fixed it. Congestion is *bursty* (a model that 503s now answers in 2s a
moment later) and it is *uncorrelated across models* (a parallel probe found 3.8-flash and
3.6-flash free while 3.7 and 3.5 were saturated). So `generate()` hedges:

- start the best model immediately;
- if it has not answered within 2s, start the next model **alongside** it, and so on;
- each worker keeps retrying its own model with exponential backoff while it is merely busy;
- the first success wins and the losers are abandoned (the pool is shut down with
  `cancel_futures=True` rather than exiting a `with` block, which would block on them);
- a 25-second deadline caps the whole thing.

That took the success rate from 1-in-3 to 5-in-5 across consecutive runs. Compiles still
took 20–45s while the API was hot, but they *completed*, and the same code returns in ~3s
when the API is idle.

## Limitations (honest ones)

- Very messy or crossing arrows can be misread; the `warnings` panel is how the app admits
  this, but it will not catch every case.
- Compile latency depends entirely on how contended the API is at that moment — ~3s when
  idle, 20-45s under the load we saw during the event.
- Glare and low contrast hurt accuracy more than handwriting quality does.
- Gemini's normalized coordinates are approximate, so the renderer applies a separation pass
  to stop boxes overlapping — the layout resembles the drawing rather than matching it exactly.
- One photo per scan; a machine spanning several sheets is not supported.
- Guard conditions are treated as opaque labels. The executor fires transitions you choose;
  it does not evaluate expressions.

## Where this goes next

- **Export**: emit the compiled machine as XState, Mermaid, SCXML or Python so the paper
  sketch becomes real source code in one step.
- **Live re-scan**: keep the camera running and recompile on change, so editing the paper
  edits the running program continuously.
- **Variables and guards**: let `count < 3` on an arrow actually evaluate, turning the paper
  into a real programming surface.
- **Whiteboard mode**: the same loop in a meeting room, where the diagram on the wall is the
  prototype everyone is already arguing about.

## Team

<!-- Add team member names here before submitting. -->

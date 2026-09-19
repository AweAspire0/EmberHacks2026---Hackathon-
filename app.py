"""Paper Machine — photograph a hand-drawn diagram, run it as a live state machine.

Gemini is the compiler: it reads the photo of the drawing and emits a structured
graph (nodes, edges, labels, normalized layout). The browser executes that graph.
"""

import json
import os
import re
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed

from dotenv import load_dotenv
from flask import Flask, jsonify, render_template, request

from google import genai
from google.genai import types

load_dotenv()

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024  # 20 MB photos

# Preference order, best first. The key handed out at the event does not have access
# to every model, and some models are *listed* but 404 on use ("no longer available to
# new users"), so we resolve against the live list AND fall through on failure.
# Ordered by capability, but nudged by what actually answered during the event:
# 3.7 and 3.5 were consistently saturated while 3.6 and flash-latest were free.
MODEL_PREFERENCE = [
    "gemini-3.8-flash",
    "gemini-3.6-flash",
    "gemini-flash-latest",
    "gemini-3-flash-preview",
    "gemini-3.7-flash",
    "gemini-3.5-flash",
]

_client = None
_client_key = None
_model = None
_candidates = None


def api_key():
    """Re-read .env on every check so pasting a key in does not need a restart."""
    load_dotenv(override=True)
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    return "" if key in ("", "paste_your_key_here") else key


def client():
    global _client, _client_key
    key = api_key()
    if _client is None or _client_key != key:
        # Tried disabling the SDK's own 5xx retries so our hedging could fail fast
        # across models. Under real congestion that was worse: calls legitimately
        # take 30s+ when the service is loaded, so a short client timeout killed
        # requests that would have succeeded. Leaving the SDK's retries in place.
        _client = genai.Client(api_key=key)
        _client_key = key
    return _client


def candidate_models():
    """Ordered list of models worth trying, best first."""
    global _candidates
    if _candidates is not None:
        return _candidates

    override = os.environ.get("GEMINI_MODEL", "").strip()
    if override:
        _candidates = [override]
        return _candidates

    try:
        available = []
        for m in client().models.list():
            name = (m.name or "").removeprefix("models/")
            actions = getattr(m, "supported_actions", None) or []
            if name and "generateContent" in actions:
                available.append(name)

        ranked = [n for n in MODEL_PREFERENCE if n in available]
        # Anything else flash-shaped, newest-looking first, as a safety net.
        extra = sorted(
            (n for n in available
             if "flash" in n and n not in ranked
             and not any(k in n for k in ("image", "lite", "audio", "live", "2.5"))),
            reverse=True,
        )
        _candidates = ranked + extra
    except Exception as exc:  # network hiccup, restricted key, old SDK
        app.logger.warning("model listing failed (%s); using preference list blind", exc)
        _candidates = list(MODEL_PREFERENCE)

    app.logger.info("model candidates: %s", ", ".join(_candidates[:4]) or "(none)")
    return _candidates


def resolve_model():
    """The model we are currently betting on — the first candidate until one fails."""
    models = candidate_models()
    return _model or (models[0] if models else MODEL_PREFERENCE[0])


# This model will never work for this key — move on immediately.
DEAD = ("404", "NOT_FOUND", "not supported", "PERMISSION_DENIED")
# This model exists but cannot take an image — remember and never try it again.
BLIND = ("modality",)
# Busy right now — worth a retry, then try a different model.
BUSY = ("503", "UNAVAILABLE", "429", "RESOURCE_EXHAUSTED", "overloaded", "high demand",
        "504", "DEADLINE_EXCEEDED", "timed out", "timeout")

MAX_MODELS = 4     # do not spend a minute walking the whole list while a judge watches
HEDGE_DELAY = 2.0  # seconds before giving up waiting and starting the next model too
DEADLINE = 45.0    # hard cap on how long one compile may spend retrying

_no_image = set()  # models that turned out to be text-only


class AllModelsBusy(RuntimeError):
    """Every model we tried was rate-limited or overloaded."""


def generate(image_bytes, mime_type, prompt):
    """Call Gemini, racing a few models so one overloaded model cannot stall the demo.

    At a hackathon everyone hammers the newest model at once, so 503s are common but
    bursty — at any instant some models answer in seconds while others are saturated.
    Walking them one at a time took ~50s. Instead we hedge: start the best model, and
    if it has not answered within HEDGE_DELAY, start the next one alongside it. First
    success wins, the losers are abandoned. Worst case is now bounded by the slowest
    model that answers at all, not by the sum of every model that does not.
    """
    global _model
    models = [m for m in candidate_models() if m not in _no_image]
    if not models:
        raise RuntimeError("No image-capable Gemini models are available to this API key.")

    # Bet on the one we know works, then the rest in preference order.
    order = ([_model] if _model in models else []) + [m for m in models if m != _model]
    order = order[:MAX_MODELS]

    won = threading.Event()
    errors = {}

    def attempt(index, name):
        # Stagger the starts so we only pay for a second model if the first is slow.
        if index and won.wait(timeout=HEDGE_DELAY * index):
            return None

        deadline = time.monotonic() + DEADLINE
        backoff = 1.0

        # Keep retrying this model while it is merely busy — some other model may
        # well win first, in which case `won` cuts this short.
        while not won.is_set() and time.monotonic() < deadline:
            try:
                response = client().models.generate_content(
                    model=name,
                    contents=[
                        types.Part.from_bytes(data=image_bytes, mime_type=mime_type),
                        prompt,
                    ],
                    config=types.GenerateContentConfig(
                        response_mime_type="application/json",
                        temperature=0.1,
                    ),
                )
            except Exception as exc:
                message = str(exc)
                errors[name] = message

                if any(k in message for k in BLIND):
                    app.logger.warning("model %s cannot take images, blacklisting", name)
                    _no_image.add(name)
                    return None
                if any(k in message for k in DEAD):
                    return None
                if any(k in message for k in BUSY):
                    if won.wait(timeout=backoff):
                        return None
                    backoff = min(backoff * 1.7, 5.0)
                    continue
                raise  # a real error (auth, bad request) — surface it
            return name, response
        return None

    # Deliberately not a `with` block: its __exit__ waits for the losing calls to
    # finish, which would hand back the latency we just bought.
    pool = ThreadPoolExecutor(max_workers=len(order))
    try:
        futures = [pool.submit(attempt, i, name) for i, name in enumerate(order)]
        for future in as_completed(futures):
            result = future.result()
            if result is None:
                continue
            name, response = result
            won.set()  # release any hedge still waiting to start
            if _model != name:
                app.logger.info("using model: %s", name)
                _model = name
            return response
    finally:
        won.set()
        pool.shutdown(wait=False, cancel_futures=True)

    if errors and all(any(k in m for k in BUSY) for m in errors.values()):
        raise AllModelsBusy(
            "Gemini is overloaded right now — every model returned 'high demand'. "
            "This is the API being busy, not a problem with your drawing. Try again."
        )
    raise RuntimeError("Every candidate model failed: " + "; ".join(
        f"{n}: {m[:80]}" for n, m in errors.items()) or "no models tried")


# --------------------------------------------------------------------------
# The prompt. This is the actual product — treat it as source code.
# --------------------------------------------------------------------------

SCHEMA = """{
  "title": string,                    // short name for the machine, from the drawing if written
  "kind": "state_machine" | "flowchart",
  "nodes": [
    {
      "id": string,                   // short slug, unique, e.g. "locked"
      "label": string,                // the text as written on the paper
      "type": "start" | "state" | "decision" | "action" | "end",
      "x": number,                    // 0..1, left to right, matching the drawing
      "y": number                     // 0..1, top to bottom, matching the drawing
    }
  ],
  "edges": [
    {
      "from": string,                 // node id
      "to": string,                   // node id
      "label": string                 // the event/condition written on the arrow ("" if unlabelled)
    }
  ],
  "warnings": [string]                // anything you could not read or had to guess
}"""

PROMPT = f"""You are a vision compiler. You convert a photograph of a HAND-DRAWN diagram
into an executable state machine. You are not describing the picture — your output is
compiled and run, so it must be structurally correct.

Read the photograph carefully and extract:

1. NODES. Every drawn shape that holds a label: circles, ovals, boxes, diamonds.
   - A diamond is type "decision".
   - A shape marked as the beginning (a filled dot, an arrow coming from nothing, or
     labelled "start"/"begin") is type "start". There must be exactly one.
   - A double circle, a shaded shape, or a label like "end"/"done"/"accept" is type "end".
   - A rectangle describing something happening is type "action"; anything else is "state".

2. EDGES. Every arrow between shapes. Direction matters — follow the arrowhead.
   - The text written on or beside an arrow is the event that fires the transition.
     Put it in "label" exactly as written.
   - An arrow that loops back to its own shape is a valid edge where from == to.
   - If an arrow has no text, use an empty string.

3. LAYOUT. Give each node normalized x,y coordinates matching where it sits in the
   photograph, with (0,0) at the top-left of the drawing and (1,1) at the bottom-right.
   Ignore the paper's margins — use the bounding box of the drawing itself. The rendered
   result should look like what was drawn.

Rules:
- Handwriting is messy. Make your best reading rather than dropping a node or arrow,
  and record every guess in "warnings".
- Node ids must be short lowercase slugs derived from the label, and unique.
- Every edge must reference node ids that exist in "nodes".
- Do not invent nodes or arrows that are not drawn.
- Output JSON only, no prose, no markdown fences, matching exactly this shape:

{SCHEMA}
"""


def extract_json(text):
    """Models occasionally wrap JSON in fences despite being told not to."""
    text = (text or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", text, re.DOTALL)
        if not match:
            raise
        return json.loads(match.group(0))


QUOTES = "\"'“”‘’"


def clean_label(value):
    """Strip the punctuation people draw *as* notation, not as part of the name.

    A state drawn as `(logged out)` is named "logged out" — the parentheses are the
    circle. Likewise `((Logged In))` is an end state, and an event written on an arrow
    as `"wrong password"` is just the event. Gemini reports these faithfully, which is
    correct of it; stripping them is our job, not the model's.
    """
    text = str(value or "").strip()
    for _ in range(4):  # handles (("x")) and similar nesting
        if len(text) > 2 and text[0] in QUOTES and text[-1] in QUOTES:
            text = text[1:-1].strip()
        elif len(text) > 2 and text[0] == "(" and text[-1] == ")":
            text = text[1:-1].strip()
        else:
            break
    return text


def slugify(value, fallback):
    slug = re.sub(r"[^a-z0-9]+", "_", str(value or "").lower()).strip("_")
    return slug or fallback


def normalize(graph):
    """Make the graph safe to execute: unique ids, valid edges, exactly one start."""
    warnings = list(graph.get("warnings") or [])

    nodes, seen = [], set()
    for i, raw in enumerate(graph.get("nodes") or []):
        label = clean_label(raw.get("label")) or clean_label(raw.get("id"))
        node_id = slugify(raw.get("id") or label, f"n{i}")
        while node_id in seen:
            node_id += "_"
        seen.add(node_id)

        node_type = raw.get("type") if raw.get("type") in {
            "start", "state", "decision", "action", "end"
        } else "state"

        def coord(key, default):
            try:
                return min(1.0, max(0.0, float(raw.get(key, default))))
            except (TypeError, ValueError):
                return default

        nodes.append({
            "id": node_id,
            "label": label or node_id,
            "type": node_type,
            "x": coord("x", 0.5),
            "y": coord("y", 0.5),
            "original_id": raw.get("id"),
        })

    if not nodes:
        raise ValueError("No nodes found in the drawing.")

    # Map whatever the model called a node onto our cleaned ids.
    lookup = {}
    for node in nodes:
        lookup[node["id"]] = node["id"]
        if node["original_id"]:
            lookup[slugify(node["original_id"], node["id"])] = node["id"]
        lookup[slugify(node["label"], node["id"])] = node["id"]

    edges = []
    for raw in graph.get("edges") or []:
        src = lookup.get(slugify(raw.get("from"), ""))
        dst = lookup.get(slugify(raw.get("to"), ""))
        if not src or not dst:
            warnings.append(
                f"Dropped an arrow ({raw.get('from')} to {raw.get('to')}) "
                "because it pointed at a shape that was not detected."
            )
            continue
        edges.append({"from": src, "to": dst, "label": clean_label(raw.get("label"))})

    starts = [n for n in nodes if n["type"] == "start"]
    if not starts:
        incoming = {e["to"] for e in edges}
        orphans = [n for n in nodes if n["id"] not in incoming]
        chosen = orphans[0] if orphans else nodes[0]
        chosen["type"] = "start"
        warnings.append(f"No start marker was drawn — assuming '{chosen['label']}' is the start.")
    elif len(starts) > 1:
        for extra in starts[1:]:
            extra["type"] = "state"
        warnings.append("More than one start was drawn — using the first one.")

    for node in nodes:
        node.pop("original_id", None)

    return {
        "title": str(graph.get("title") or "Untitled machine").strip(),
        "kind": graph.get("kind") if graph.get("kind") in {"state_machine", "flowchart"} else "state_machine",
        "nodes": nodes,
        "edges": edges,
        "warnings": warnings,
    }


@app.get("/")
def index():
    return render_template("index.html", has_key=bool(api_key()))


@app.get("/api/health")
def health():
    has_key = bool(api_key())
    return jsonify({"ok": True, "has_key": has_key, "model": resolve_model() if has_key else None})


@app.post("/api/compile")
def compile_drawing():
    if not api_key():
        return jsonify({"error": "No GEMINI_API_KEY in .env yet. Paste your key in and try again."}), 400

    upload = request.files.get("image")
    if upload is None:
        return jsonify({"error": "No image was sent."}), 400

    image_bytes = upload.read()
    if not image_bytes:
        return jsonify({"error": "The image was empty."}), 400

    mime_type = upload.mimetype or "image/jpeg"
    hint = (request.form.get("hint") or "").strip()
    prompt = PROMPT
    if hint:
        prompt += f"\n\nExtra context from the person who drew it: {hint}\n"

    try:
        response = generate(image_bytes, mime_type, prompt)
        graph = normalize(extract_json(response.text))
    except AllModelsBusy as exc:
        return jsonify({"error": str(exc)}), 503
    except ValueError as exc:
        return jsonify({"error": str(exc)}), 422
    except Exception as exc:
        app.logger.exception("compile failed")
        return jsonify({"error": f"Gemini call failed: {exc}"}), 502

    graph["model"] = resolve_model()
    return jsonify(graph)


if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5001, debug=True, use_reloader=False)

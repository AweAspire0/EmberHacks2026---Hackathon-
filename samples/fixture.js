/* Synthetic "hand-drawn" test diagram — a vending machine state chart.
 *
 * Paste this into the browser devtools console on http://localhost:5001 to load a
 * wobbly fake sketch into the capture panel without needing paper or a camera.
 * Useful for testing the Gemini round-trip; it is NOT a substitute for testing on a
 * real photo, which is harder (glare, perspective, real handwriting).
 *
 * After running it, click "Compile with Gemini".
 */
(() => {
  const c = document.createElement("canvas");
  c.width = 1000; c.height = 700;
  const g = c.getContext("2d");
  g.fillStyle = "#fdfdf8"; g.fillRect(0, 0, 1000, 700);
  g.strokeStyle = "#1a1a2e"; g.fillStyle = "#1a1a2e";
  g.lineWidth = 2.6; g.lineCap = "round"; g.lineJoin = "round";

  const J = () => (Math.random() - 0.5) * 3.2;
  const wobbleLine = (x1, y1, x2, y2) => {
    g.beginPath(); g.moveTo(x1, y1);
    for (let i = 1; i <= 14; i++) {
      const t = i / 14;
      g.lineTo(x1 + (x2 - x1) * t + J(), y1 + (y2 - y1) * t + J());
    }
    g.stroke();
  };
  const wobbleEllipse = (cx, cy, rx, ry) => {
    g.beginPath();
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      const x = cx + Math.cos(a) * rx + J(), y = cy + Math.sin(a) * ry + J();
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.closePath(); g.stroke();
  };
  const head = (x, y, a) => {
    g.beginPath();
    g.moveTo(x, y); g.lineTo(x - 15 * Math.cos(a - 0.45), y - 15 * Math.sin(a - 0.45));
    g.moveTo(x, y); g.lineTo(x - 15 * Math.cos(a + 0.45), y - 15 * Math.sin(a + 0.45));
    g.stroke();
  };
  const label = (t, x, y) => {
    g.font = "italic 21px Bradley Hand, Segoe Script, cursive";
    g.textAlign = "center";
    g.fillText(t, x, y);
  };

  wobbleEllipse(200, 250, 86, 50); label("Idle", 200, 257);
  wobbleEllipse(560, 250, 96, 52); label("Has credit", 560, 257);
  wobbleEllipse(560, 540, 92, 50); wobbleEllipse(560, 540, 82, 41); label("Dispensed", 560, 547);

  wobbleLine(70, 250, 112, 250); head(114, 250, 0); label("start", 75, 228);
  wobbleLine(288, 236, 462, 236); head(464, 236, 0); label("insert coin", 372, 220);
  wobbleLine(462, 272, 288, 272); head(286, 272, Math.PI); label("refund", 372, 297);
  wobbleLine(560, 304, 560, 488); head(560, 490, Math.PI / 2); label("select item", 640, 400);

  g.beginPath();
  for (let i = 0; i <= 40; i++) {
    const a = Math.PI * 1.15 + (i / 40) * Math.PI * 1.6;
    const x = 612 + Math.cos(a) * 54 + J(), y = 176 + Math.sin(a) * 46 + J();
    i ? g.lineTo(x, y) : g.moveTo(x, y);
  }
  g.stroke();
  head(645, 203, 1.4); label("insert coin", 700, 150);

  c.toBlob((blob) => {
    usePhoto(blob);
    console.log("fixture loaded — click 'Compile with Gemini'");
  }, "image/png");
})();

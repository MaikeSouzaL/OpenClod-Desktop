export function overlayHtml(primary: boolean): string {
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="color-scheme" content="dark">
<style>
  html, body { margin: 0; width: 100%; height: 100%; overflow: hidden; background: transparent; pointer-events: none; }
  body { font-family: "Segoe UI", system-ui, -apple-system, sans-serif; }
  .frame {
    position: absolute; inset: 4px; border-radius: 16px; pointer-events: none;
    border: 2px solid rgba(255, 122, 26, 0.92);
    box-shadow:
      inset 0 0 3px rgba(255, 196, 140, 0.85),
      inset 0 0 30px rgba(255, 122, 26, 0.20),
      0 0 26px rgba(255, 122, 26, 0.30);
    animation: breathe 2.8s ease-in-out infinite;
  }
  @keyframes breathe {
    50% {
      border-color: rgba(255, 154, 74, 1);
      box-shadow:
        inset 0 0 4px rgba(255, 214, 170, 0.95),
        inset 0 0 38px rgba(255, 122, 26, 0.26),
        0 0 34px rgba(255, 122, 26, 0.40);
    }
  }

  .mascot {
    position: absolute; top: 24px; left: 50%; transform: translateX(-50%);
    display: none; flex-direction: column; align-items: center; gap: 7px;
    pointer-events: none; user-select: none;
  }
  body.primary .mascot { display: flex; }
  .halo {
    position: absolute; top: -16px; left: 50%; margin-left: -54px; width: 108px; height: 78px;
    border-radius: 50%; background: radial-gradient(closest-side, rgba(255, 122, 26, 0.34), rgba(255, 122, 26, 0));
    filter: blur(3px); animation: halo 3.2s ease-in-out infinite;
  }
  @keyframes halo { 50% { transform: scale(1.1); opacity: 0.72; } }

  .guy {
    position: relative; width: 74px; height: 78px; display: flex; flex-direction: column;
    align-items: center; animation: bob 3.4s ease-in-out infinite;
  }
  .head {
    position: relative; width: 62px; height: 57px; z-index: 2;
    border-radius: 46% 46% 44% 44%;
    background: linear-gradient(160deg, #ffc590 0%, #ff9a52 52%, #f97316 100%);
    box-shadow:
      inset 0 -6px 12px rgba(180, 60, 0, 0.16),
      inset 0 4px 8px rgba(255, 255, 255, 0.42),
      0 9px 20px rgba(0, 0, 0, 0.30);
  }
  .ear {
    position: absolute; top: 20px; width: 14px; height: 20px; border-radius: 50%;
    background: #fb923c; box-shadow: inset 0 -3px 6px rgba(160, 50, 0, 0.18);
  }
  .ear.l { left: -7px; transform: rotate(-12deg); }
  .ear.r { right: -7px; transform: rotate(12deg); }

  .eyes { position: absolute; top: 15px; left: 0; right: 0; display: flex; justify-content: center; gap: 12px; }
  .eye {
    position: relative; width: 16px; height: 18px; border-radius: 50%; overflow: hidden; background: #fffdf8;
    box-shadow: inset 0 1px 3px rgba(120, 50, 10, 0.20);
  }
  .pupil {
    position: absolute; left: 50%; top: 8px; width: 8px; height: 8px; margin-left: -4px;
    border-radius: 50%; background: #2b1608; animation: scan 3.8s ease-in-out infinite;
  }
  .pupil::after {
    content: ""; position: absolute; left: 1px; top: 1px; width: 2.6px; height: 2.6px;
    border-radius: 50%; background: rgba(255, 255, 255, 0.9);
  }
  @keyframes scan {
    0%, 100% { transform: translate(-1.5px, 1px); }
    50% { transform: translate(1.5px, 2px); }
  }
  .lid {
    position: absolute; inset: 0; border-radius: 50%; background: #ff9a52;
    transform: translateY(-106%); animation: blink 5.2s infinite;
  }
  @keyframes blink {
    0%, 41%, 47%, 100% { transform: translateY(-106%); }
    44% { transform: translateY(0); }
  }
  .blush { position: absolute; top: 37px; width: 9px; height: 5px; border-radius: 50%; background: rgba(214, 65, 28, 0.30); }
  .blush.l { left: 9px; }
  .blush.r { right: 9px; }
  .mouth {
    position: absolute; left: 50%; top: 39px; width: 9px; height: 5px; margin-left: -4.5px;
    border-bottom: 2px solid #7c2d12; border-radius: 0 0 9px 9px; opacity: 0.82;
  }

  .body {
    position: relative; margin-top: -6px; width: 42px; height: 25px; z-index: 1;
    border-radius: 12px 12px 15px 15px;
    background: linear-gradient(180deg, #fb923c, #ea580c);
    box-shadow: 0 7px 15px rgba(0, 0, 0, 0.24);
  }
  .arm {
    position: absolute; top: 5px; width: 9px; height: 20px; border-radius: 6px;
    background: #fb923c; transform-origin: top center;
  }
  .arm.l { left: -7px; animation: type-left 0.72s ease-in-out infinite alternate; }
  .arm.r { right: -7px; animation: type-right 0.72s ease-in-out infinite alternate; }
  @keyframes type-left { from { transform: rotate(-20deg); } to { transform: rotate(9deg); } }
  @keyframes type-right { from { transform: rotate(20deg); } to { transform: rotate(-9deg); } }
  @keyframes bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(3px); } }

  .tag {
    display: flex; align-items: center; gap: 7px; padding: 7px 12px; border-radius: 999px;
    background: rgba(26, 21, 18, 0.90); border: 1px solid rgba(255, 122, 26, 0.34);
    color: #ffe4cc; font-size: 12px; line-height: 1; letter-spacing: 0.01em; white-space: nowrap;
    box-shadow: 0 8px 26px rgba(0, 0, 0, 0.36); backdrop-filter: blur(10px);
  }
  .tag .dot {
    width: 7px; height: 7px; border-radius: 50%; background: #ff7a1a;
    box-shadow: 0 0 0 4px rgba(255, 122, 26, 0.16); animation: pulse 1.5s ease-in-out infinite;
  }
  @keyframes pulse { 50% { transform: scale(0.68); opacity: 0.6; } }

  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; }
  }
</style>
</head>
<body${primary ? ' class="primary"' : ''}>
  <div class="frame"></div>
  <div class="mascot" aria-hidden="true">
    <div class="halo"></div>
    <div class="guy">
      <div class="head">
        <span class="ear l"></span>
        <span class="ear r"></span>
        <div class="eyes">
          <span class="eye"><span class="pupil"></span><span class="lid"></span></span>
          <span class="eye"><span class="pupil"></span><span class="lid"></span></span>
        </div>
        <span class="blush l"></span>
        <span class="blush r"></span>
        <span class="mouth"></span>
      </div>
      <div class="body"><span class="arm l"></span><span class="arm r"></span></div>
    </div>
    <div class="tag"><span class="dot"></span>Openclod está usando o computador</div>
  </div>
</body>
</html>`
}

// A slowly turning ball of dots, shown while prices are being fetched. Returns a function that stops it.
function startSphere(canvas) {
    const size = 120, dpr = window.devicePixelRatio || 1;
    canvas.width = canvas.height = size * dpr;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const N = 170, R = 46, C = size / 2;
    // points spread evenly over a sphere (golden-angle spiral)
    const pts = Array.from({ length: N }, (_, i) => {
        const y = 1 - 2 * (i + .5) / N, r = Math.sqrt(1 - y * y), a = i * 2.399963;
        return [Math.cos(a) * r, y, Math.sin(a) * r];
    });
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches; // one still frame for people who asked for no motion
    let frame = 0;
    function draw(t) {
        const a = still ? .6 : t / 1700, ca = Math.cos(a), sa = Math.sin(a);
        ctx.clearRect(0, 0, size, size);
        ctx.fillStyle = '#059669';
        for (const [x, y, z] of pts) {
            const X = x * ca + z * sa, Z = z * ca - x * sa;      // turn around the vertical axis
            const depth = (Z + 1) / 2;                           // 0 = far side, 1 = near side
            const wave = still ? 0 : Math.sin(t / 350 + y * 5);  // a band of larger dots travelling down: "thinking"
            ctx.globalAlpha = .18 + .82 * depth;
            ctx.beginPath();
            ctx.arc(C + X * R, C + y * R, .7 + 1.4 * depth + .5 * Math.max(0, wave) * depth, 0, 6.2832);
            ctx.fill();
        }
        if (!still) frame = requestAnimationFrame(draw);
    }
    draw(performance.now());
    return () => cancelAnimationFrame(frame);
}

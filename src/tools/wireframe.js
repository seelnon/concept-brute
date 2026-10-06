export function paintWireframeIncrementally(engine, j) {
    const points = engine.strokePoints;
    if (j < 1 || j >= points.length) return;
    
    const p = points[j];
    const lastP = points[j - 1];
    const dynamicSize = p.size;
    const opacMod = p.opacity;
    const globalOpacity = engine.brush.opacity ?? 1.0;
    
    const thresholdMaxRatio = engine.brush.wireRange ?? 4.0;
    const thresholdMinRatio = engine.brush.wireMinDist ?? 0.5;
    const maxSeek = engine.brush.wireDensity ?? 30;
    
    // Find all line segments to draw for this point
    const segments = [];
    
    // 1. Connection lines
    const thresholdMax = dynamicSize * thresholdMaxRatio;
    const thresholdMin = dynamicSize * thresholdMinRatio;
    const connOpacity = opacMod * 0.2 * globalOpacity;
    const baseConnWidth = Math.max(0.3, dynamicSize * 0.05);
    
    for (let i = Math.max(0, j - maxSeek); i < j - 1; i++) {
        const prevP = points[i];
        const d = Math.sqrt((prevP.x - p.x)**2 + (prevP.y - p.y)**2);
        if (d > thresholdMin && d < thresholdMax) {
            segments.push({
                type: 'conn',
                from: prevP,
                to: p,
                width: baseConnWidth,
                opacity: connOpacity,
                color: p.color
            });
        }
    }
    
    // 2. Main segment
    const baseMainWidth = Math.max(0.5, dynamicSize * 0.15);
    segments.push({
        type: 'main',
        from: lastP,
        to: p,
        width: baseMainWidth,
        opacity: opacMod * globalOpacity,
        color: p.color
    });
    
    // Draw segments on affected chunks
    for (const seg of segments) {
        const pad = seg.width + 5;
        const minX = Math.min(seg.from.x, seg.to.x) - pad;
        const maxX = Math.max(seg.from.x, seg.to.x) + pad;
        const minY = Math.min(seg.from.y, seg.to.y) - pad;
        const maxY = Math.max(seg.from.y, seg.to.y) + pad;
        
        engine.strokeMinX = Math.min(engine.strokeMinX, minX);
        engine.strokeMaxX = Math.max(engine.strokeMaxX, maxX);
        engine.strokeMinY = Math.min(engine.strokeMinY, minY);
        engine.strokeMaxY = Math.max(engine.strokeMaxY, maxY);
        
        const sCX = engine.isStatic ? 0 : Math.floor(minX / engine.chunkSize);
        const eCX = engine.isStatic ? 0 : Math.floor(maxX / engine.chunkSize);
        const sCY = engine.isStatic ? 0 : Math.floor(minY / engine.chunkSize);
        const eCY = engine.isStatic ? 0 : Math.floor(maxY / engine.chunkSize);
        
        for (let cx = sCX; cx <= eCX; cx++) {
            for (let cy = sCY; cy <= eCY; cy++) {
                const chunk = engine._getChunk(cx, cy);
                if (!chunk) continue;
                
                const id = `${cx},${cy}`;
                if (!engine.currentStrokeDirtyChunks.has(id)) {
                    const srcCanvas = chunk.canvases[engine.activeLayer];
                    const backup = document.createElement('canvas');
                    backup.width = srcCanvas.width; backup.height = srcCanvas.height;
                    backup.getContext('2d').drawImage(srcCanvas, 0, 0);
                    engine.currentStrokeDirtyChunks.set(id, { layer: engine.activeLayer, canvas: backup });
                    engine._markDirty(id, engine.activeLayer);
                }
                
                // Show stroke canvas
                engine._ensureStrokeCanvas(chunk);
                chunk.strokeCanvas.style.opacity = engine.brush.opacity;
                
                const lx = engine.isStatic ? -engine.staticWidth / 2 : cx * engine.chunkSize;
                const ly = engine.isStatic ? -engine.staticHeight / 2 : cy * engine.chunkSize;
                
                const ctx = chunk.strokeCtx;
                ctx.save();
                
                // Drawing wireframes/sketchy connectors onto strokeCtx. These are clipped once-off inside _endStroke, so interactive drawing is fast!
                
                ctx.globalCompositeOperation = 'source-over';
                ctx.globalAlpha = seg.opacity;
                ctx.lineWidth = seg.width;
                ctx.strokeStyle = seg.color;
                ctx.beginPath();
                ctx.moveTo(seg.from.x - lx, seg.from.y - ly);
                ctx.lineTo(seg.to.x - lx, seg.to.y - ly);
                ctx.stroke();
                
                ctx.restore();
                if (engine.gpuRenderer) {
                    engine.gpuRenderer.markChunkStrokeDirty(chunk, true);
                }
            }
        }
    }
}

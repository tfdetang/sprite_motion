import React, { useRef, useEffect, useState } from 'react';
import { SpriteConfig, ImageDimensions } from '../types';
import { Play, Pause } from 'lucide-react';

interface PreviewPlayerProps {
  imageUrl: string | null;
  config: SpriteConfig;
  dimensions: ImageDimensions;
}

const hexToRgb = (hex: string) => {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return result ? {
    r: parseInt(result[1], 16),
    g: parseInt(result[2], 16),
    b: parseInt(result[3], 16)
  } : null;
};

// Helper to apply transparency to ImageData (runs per frame in preview)
const processTransparency = (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  targetRGB: { r: number, g: number, b: number },
  thresholdSq: number,
  useFloodFill: boolean
) => {
  const { r: tr, g: tg, b: tb } = targetRGB;

  const matches = (idx: number) => {
    const r = data[idx];
    const g = data[idx + 1];
    const b = data[idx + 2];
    // Check if within tolerance
    const distSq = (r - tr) * (r - tr) + (g - tg) * (g - tg) + (b - tb) * (b - tb);
    return distSq <= thresholdSq;
  };

  if (!useFloodFill) {
    // Simple global replacement
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] > 0 && matches(i)) {
        data[i + 3] = 0; // Set Alpha to 0
      }
    }
    return;
  }

  // Flood Fill Logic (Edge-based)
  const visited = new Uint8Array(width * height);
  const queue: number[] = [];

  const addSeed = (x: number, y: number) => {
    const idx = y * width + x;
    if (visited[idx]) return;
    const pIdx = idx * 4;
    // If pixel is valid match, add to queue
    if (data[pIdx + 3] > 0 && matches(pIdx)) {
      visited[idx] = 1;
      queue.push(idx);
    }
  };

  // Seed from edges
  for (let x = 0; x < width; x++) { addSeed(x, 0); addSeed(x, height - 1); }
  for (let y = 1; y < height - 1; y++) { addSeed(0, y); addSeed(width - 1, y); }

  let head = 0;
  while (head < queue.length) {
    const idx = queue[head++];
    const pIdx = idx * 4;
    data[pIdx + 3] = 0; // Set transparent

    const x = idx % width;
    const y = Math.floor(idx / width);

    const neighbors = [
      { nx: x + 1, ny: y },
      { nx: x - 1, ny: y },
      { nx: x, ny: y + 1 },
      { nx: x, ny: y - 1 }
    ];

    for (const { nx, ny } of neighbors) {
      if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
        const nIdx = ny * width + nx;
        if (!visited[nIdx]) {
          const npIdx = nIdx * 4;
          if (data[npIdx + 3] > 0 && matches(npIdx)) {
            visited[nIdx] = 1;
            queue.push(nIdx);
          }
        }
      }
    }
  }
};

// Helper to get Bounding Box based on non-transparent pixels
const getAlphaBoundingBox = (data: Uint8ClampedArray, width: number, height: number) => {
  let minX = width, minY = height, maxX = 0, maxY = 0;
  let found = false;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (data[idx + 3] > 0) { // Alpha > 0 means content
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        found = true;
      }
    }
  }

  return found ? { minX, minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null;
};

export const PreviewPlayer: React.FC<PreviewPlayerProps> = ({ imageUrl, config, dimensions }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const requestRef = useRef<number>(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [currentFrameDisplayIndex, setCurrentFrameDisplayIndex] = useState(0); 
  
  // Helper to get sequence of VALID frame indices
  const getValidFrameIndices = () => {
     const { rows, cols, totalFrames, excludedFrames, readOrder = 'row-major' } = config;
     const indices: number[] = [];
     
     if (readOrder === 'column-major') {
         for (let c = 0; c < cols; c++) {
             for (let r = 0; r < rows; r++) {
                 const i = c * rows + r;
                 if (i < totalFrames && !excludedFrames.includes(i)) indices.push(i);
             }
         }
     } else {
         for (let r = 0; r < rows; r++) {
             for (let c = 0; c < cols; c++) {
                 const i = r * cols + c;
                 if (i < totalFrames && !excludedFrames.includes(i)) indices.push(i);
             }
         }
     }
     return indices;
  };

  useEffect(() => {
    if (!imageUrl || !canvasRef.current || dimensions.width === 0) return;

    const img = new Image();
    img.src = imageUrl;
    
    let transparentRGB: { r: number, g: number, b: number } | null = null;
    if (config.transparent) {
        transparentRGB = hexToRgb(config.transparent);
    }
    const maxDist = 441.67;
    const thresholdSq = Math.pow((config.tolerance / 100) * maxDist, 2);

    const animate = (time: number) => {
      if (!canvasRef.current) return;
      
      const validIndices = getValidFrameIndices();
      if (validIndices.length === 0) return; // Nothing to play

      const { rows, cols, crop, scale, fps, autoAlign, alignMode } = config;
      const frameInterval = 1000 / fps;
      
      const tick = Math.floor(time / frameInterval);
      const indexInValid = tick % validIndices.length;
      const frameIndex = validIndices[indexInValid];
      
      setCurrentFrameDisplayIndex(indexInValid + 1);

      const ctx = canvasRef.current.getContext('2d', { willReadFrequently: true });
      if (!ctx) return;

      const frameWidthRaw = dimensions.width / cols;
      const frameHeightRaw = dimensions.height / rows;

      // Crop dimensions
      const cropW = Math.max(1, frameWidthRaw - crop.left - crop.right);
      const cropH = Math.max(1, frameHeightRaw - crop.top - crop.bottom);

      // Canvas setup
      canvasRef.current.width = cropW * scale;
      canvasRef.current.height = cropH * scale;
      
      // Calculate row/col
      let col, row;
      if (config.readOrder === 'column-major') {
          row = frameIndex % rows;
          col = Math.floor(frameIndex / rows);
      } else {
          col = frameIndex % cols;
          row = Math.floor(frameIndex / cols);
      }
      
      const srcX = (col * frameWidthRaw) + crop.left;
      const srcY = (row * frameHeightRaw) + crop.top;

      ctx.imageSmoothingEnabled = false;

      // --- Processing Stage ---
      // 1. Draw frame to a temporary canvas (1:1 scale) to process pixels
      const tempCanvas = document.createElement('canvas');
      tempCanvas.width = cropW;
      tempCanvas.height = cropH;
      const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true });
      
      if (tempCtx) {
          tempCtx.drawImage(img, srcX, srcY, cropW, cropH, 0, 0, cropW, cropH);

          // 2. Apply Transparency if enabled
          if (config.transparent && transparentRGB) {
              const imgData = tempCtx.getImageData(0, 0, cropW, cropH);
              processTransparency(imgData.data, cropW, cropH, transparentRGB, thresholdSq, config.useFloodFill);
              tempCtx.putImageData(imgData, 0, 0);
          }

          // --- Rendering Stage ---
          ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
          
          // Draw white background ONLY if transparency is OFF
          // If transparency is ON, we want the CSS checkerboard to show through
          if (!config.transparent) {
              ctx.fillStyle = '#ffffff';
              ctx.fillRect(0, 0, canvasRef.current.width, canvasRef.current.height);
          }

          if (autoAlign) {
              // Get bbox from the processed image data (checks alpha)
              const imgData = tempCtx.getImageData(0, 0, cropW, cropH);
              const bbox = getAlphaBoundingBox(imgData.data, cropW, cropH);

              if (bbox) {
                  const destX = Math.floor((canvasRef.current.width - bbox.width * scale) / 2);
                  let destY = 0;
                  if (alignMode === 'bottom') {
                      destY = canvasRef.current.height - bbox.height * scale;
                  } else {
                      destY = Math.floor((canvasRef.current.height - bbox.height * scale) / 2);
                  }

                  // Draw from processed temp canvas
                  ctx.drawImage(
                      tempCanvas,
                      bbox.minX, 
                      bbox.minY,
                      bbox.width,
                      bbox.height,
                      destX, 
                      destY,
                      bbox.width * scale, 
                      bbox.height * scale
                  );
              }
          } else {
              // Standard Draw from processed temp canvas
              ctx.drawImage(
                tempCanvas,
                0, 
                0,
                cropW, 
                cropH,
                0, 
                0,
                cropW * scale, 
                cropH * scale
              );
          }
      }

      if (isPlaying) {
        requestRef.current = requestAnimationFrame(animate);
      }
    };

    if (isPlaying) {
      requestRef.current = requestAnimationFrame(animate);
    }

    return () => {
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [imageUrl, config, dimensions, isPlaying]);

  if (!imageUrl) return null;

  return (
    <div className="flex flex-col items-center space-y-4">
      <div className="relative p-8 bg-[url('https://www.transparenttextures.com/patterns/stardust.png')] bg-slate-800 rounded-lg border border-slate-600 shadow-lg flex items-center justify-center min-h-[200px] w-full overflow-hidden">
        <canvas ref={canvasRef} className="max-w-full max-h-[300px] object-contain shadow-sm" />
        
        {/* Helper lines */}
        {config.autoAlign && (
            <div className="absolute inset-0 pointer-events-none flex items-center justify-center opacity-20">
                {/* Horizontal Center Line */}
                <div className="h-full w-[1px] bg-red-500 absolute"></div>
                
                {/* Vertical Indicator depending on mode */}
                {config.alignMode === 'center' ? (
                   <div className="w-full h-[1px] bg-red-500 absolute"></div>
                ) : (
                   <div className="w-full h-[1px] bg-blue-500 absolute bottom-8"></div>
                )}
            </div>
        )}
      </div>
      
      <div className="flex items-center space-x-4 bg-slate-800 p-2 rounded-full border border-slate-700 shadow-lg">
        <button 
          onClick={() => setIsPlaying(!isPlaying)}
          className="p-2 rounded-full bg-indigo-500 hover:bg-indigo-600 text-white transition-colors"
        >
          {isPlaying ? <Pause size={20} /> : <Play size={20} />}
        </button>
        <span className="text-xs font-mono text-slate-400 px-2">
            帧: {currentFrameDisplayIndex} / {getValidFrameIndices().length}
        </span>
      </div>
    </div>
  );
};

import "./style.css";
import { SelectionManager } from "./ui-utils.js";
import { EvaluationManager } from "./evaluation-manager.js";

export interface Point {
  x: number;
  y: number;
}

export interface DetectedShape {
  type: "circle" | "triangle" | "rectangle" | "pentagon" | "star";
  confidence: number;
  boundingBox: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
  center: Point;
  area: number;
}

export interface DetectionResult {
  shapes: DetectedShape[];
  processingTime: number;
  imageWidth: number;
  imageHeight: number;
}

export class ShapeDetector {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d")!;
  }

  /**
   * MAIN ALGORITHM TO IMPLEMENT
   * Method for detecting shapes in an image
   * @param imageData - ImageData from canvas
   * @returns Promise<DetectionResult> - Detection results
   *
   * TODO: Implement shape detection algorithm here
   */
  async detectShapes(imageData: ImageData): Promise<DetectionResult> {
    const startTime = performance.now();
    const shapes: DetectedShape[] = [];

    const debug = typeof window !== "undefined" && window.location?.search?.includes("debugShapes");

    try {
      // Step 1: Convert to grayscale
      const grayscale = this.toGrayscale(imageData);

      // Step 2: Determine a threshold using Otsu's method for robust binarization
      const threshold = this.computeOtsuThreshold(grayscale);

      // Step 3: Decide whether shapes are darker or lighter than background.
      // If the image is mostly bright, assume darker shapes; otherwise assume lighter shapes.
      const meanGray = grayscale.reduce((sum, v) => sum + v, 0) / grayscale.length;
      const invert = meanGray > 128;

      const mask = this.binarize(
        grayscale,
        imageData.width,
        imageData.height,
        threshold,
        invert
      );

      // Step 3b: Perform a small closing operation to unify thin outlines
      const closedMask = this.morphologicalClose(mask, imageData.width, imageData.height, 1);

      // Debug: report mask density
      if (debug) {
        const pixelCount = closedMask.reduce((sum, v) => sum + v, 0);
        console.debug("[ShapeDetector] Otsu threshold:", threshold, "mask pixels:", pixelCount);
      }

      // Step 4: Find connected components in the mask
      const contours = this.findContours(closedMask, imageData.width, imageData.height);

      if (debug) {
        console.debug("[ShapeDetector] contours found:", contours.length);
      }

      // Step 5: Analyze and classify each contour
      for (const contour of contours) {
        const shape = this.analyzeContour(contour, imageData.width, imageData.height);
        if (shape) {
          shapes.push(shape);
        } else if (debug) {
          const bbox = this.calculateBoundingBox(contour);
          const area = this.calculateAreaPolygon(contour);
          console.debug("[ShapeDetector] rejected contour:", { bbox, area, count: contour.length });
        }
      }

      // Sort by area (descending)
      shapes.sort((a, b) => b.area - a.area);
    } catch (error) {
      console.error("Error in shape detection:", error);
    }

    const processingTime = performance.now() - startTime;

    return {
      shapes,
      processingTime,
      imageWidth: imageData.width,
      imageHeight: imageData.height,
    };
  }

  /**
   * Convert ImageData to grayscale
   */
  private toGrayscale(imageData: ImageData): Uint8ClampedArray {
    const data = imageData.data;
    const gray = new Uint8ClampedArray(imageData.width * imageData.height);

    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      // Standard grayscale conversion
      gray[i / 4] = 0.299 * r + 0.587 * g + 0.114 * b;
    }

    return gray;
  }

  /**
   * Convert grayscale image to a binary mask (0/1)
   */
  private binarize(
    grayscale: Uint8ClampedArray,
    width: number,
    height: number,
    threshold = 128,
    invert = false
  ): Uint8ClampedArray {
    const mask = new Uint8ClampedArray(width * height);

    for (let i = 0; i < grayscale.length; i++) {
      const value = grayscale[i];
      const isShape = invert ? value < threshold : value > threshold;
      mask[i] = isShape ? 1 : 0;
    }

    return mask;
  }

  /**
   * Compute Otsu's threshold for a grayscale image
   */
  private computeOtsuThreshold(grayscale: Uint8ClampedArray): number {
    const hist = new Array<number>(256).fill(0);
    for (const value of grayscale) {
      hist[value]++;
    }

    const total = grayscale.length;
    let sum = 0;
    for (let i = 0; i < 256; i++) {
      sum += i * hist[i];
    }

    let sumB = 0;
    let wB = 0;
    let wF = 0;
    let maxBetween = 0;
    let threshold = 0;

    for (let t = 0; t < 256; t++) {
      wB += hist[t];
      if (wB === 0) continue;
      wF = total - wB;
      if (wF === 0) break;

      sumB += t * hist[t];
      const mB = sumB / wB;
      const mF = (sum - sumB) / wF;

      const between = wB * wF * (mB - mF) * (mB - mF);
      if (between > maxBetween) {
        maxBetween = between;
        threshold = t;
      }
    }

    return threshold;
  }

  /**
   * Find connected components in a binary mask
   */
  private findContours(mask: Uint8ClampedArray, width: number, height: number): Point[][] {
    const visited = new Uint8ClampedArray(width * height);
    const contours: Point[][] = [];

    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const idx = y * width + x;
        if (mask[idx] > 0 && !visited[idx]) {
          const contour = this.traceContour(
            mask,
            visited,
            width,
            height,
            x,
            y
          );
          if (contour.length > 10) {
            // Only keep components with sufficient size
            contours.push(contour);
          }
        }
      }
    }

    return contours;
  }

  /**
   * Perform morphological closing (dilation followed by erosion)
   */
  private morphologicalClose(
    mask: Uint8ClampedArray,
    width: number,
    height: number,
    radius: number
  ): Uint8ClampedArray {
    const dilated = this.morphologicalDilate(mask, width, height, radius);
    return this.morphologicalErode(dilated, width, height, radius);
  }

  private morphologicalDilate(
    mask: Uint8ClampedArray,
    width: number,
    height: number,
    radius: number
  ): Uint8ClampedArray {
    const output = new Uint8ClampedArray(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let maxVal = 0;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              maxVal = Math.max(maxVal, mask[ny * width + nx]);
            }
          }
        }
        output[y * width + x] = maxVal;
      }
    }
    return output;
  }

  private morphologicalErode(
    mask: Uint8ClampedArray,
    width: number,
    height: number,
    radius: number
  ): Uint8ClampedArray {
    const output = new Uint8ClampedArray(width * height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        let minVal = 1;
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
              minVal = Math.min(minVal, mask[ny * width + nx]);
            }
          }
        }
        output[y * width + x] = minVal;
      }
    }
    return output;
  }

  /**
   * Trace a single connected component using flood fill
   */
  private traceContour(
    mask: Uint8ClampedArray,
    visited: Uint8ClampedArray,
    width: number,
    height: number,
    startX: number,
    startY: number
  ): Point[] {
    const contour: Point[] = [];
    const queue: Point[] = [{ x: startX, y: startY }];
    visited[startY * width + startX] = 1;

    while (queue.length > 0) {
      const point = queue.shift()!;
      contour.push(point);

      // Check 8 neighbors
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const nx = point.x + dx;
          const ny = point.y + dy;

          if (nx >= 0 && nx < width && ny >= 0 && ny < height) {
            const idx = ny * width + nx;
            if (mask[idx] > 0 && !visited[idx]) {
              visited[idx] = 1;
              queue.push({ x: nx, y: ny });
            }
          }
        }
      }
    }

    return contour;
  }

  /**
   * Analyze a contour and classify the shape
   */
  private analyzeContour(contour: Point[], imageWidth: number, imageHeight: number): DetectedShape | null {
    if (contour.length < 3) return null;

    // Use the convex hull for robust shape approximation
    const hull = this.convexHull(contour);
    if (hull.length < 3) return null;

    // Simplify the hull to reduce noisy vertex counts (important for clean classification)
    const boundingBox = this.calculateBoundingBox(hull);
    const tolerance = Math.max(2, Math.min(10, Math.max(boundingBox.width, boundingBox.height) * 0.02));
    const simplified = this.simplifyPolygon(hull, tolerance);

    const center = this.calculateCenter(simplified);
    const area = this.calculateAreaPolygon(simplified);
    const perimeter = this.calculatePerimeter(simplified);

    const bboxArea = boundingBox.width * boundingBox.height;
    const aspectRatio = Math.max(boundingBox.width, boundingBox.height) / Math.max(1, Math.min(boundingBox.width, boundingBox.height));

    // Estimate shape fill ratio to reject thin lines / low-solid artifacts
    const contourPixelArea = contour.length;
    const hullArea = this.calculateAreaPolygon(hull);
    const solidity = hullArea > 0 ? contourPixelArea / hullArea : 0;
    const fillRatio = bboxArea > 0 ? area / bboxArea : 0;

    const imageArea = imageWidth * imageHeight;
    const borderMargin = 3;
    const touchesBorder =
      boundingBox.x <= borderMargin ||
      boundingBox.y <= borderMargin ||
      boundingBox.x + boundingBox.width >= imageWidth - borderMargin ||
      boundingBox.y + boundingBox.height >= imageHeight - borderMargin;

    // Filter out small noise (tiny components) and full-image blobs
    if (bboxArea < 400) return null; // too small to be a meaningful shape
    if (bboxArea > imageArea * 0.9) return null; // likely background

    // Reject shapes that touch the image border unless they are dense enough
    if (touchesBorder && fillRatio < 0.45 && bboxArea < imageArea * 0.5) return null;

    // Reject long thin lines / text strokes
    if (aspectRatio > 6 || Math.min(boundingBox.width, boundingBox.height) < 6) return null;

    // Reject excessively perimeter-heavy regions (common in text/doodles)
    const compactness = (perimeter * perimeter) / Math.max(area, 1);
    if (compactness > 350) return null;

    // Allow large outlines (e.g., square outline) even if fill ratio is low
    const isLargeOutlineRect =
      hull.length === 4 &&
      fillRatio < 0.25 &&
      contourPixelArea > 1200 &&
      bboxArea > imageArea * 0.1;

    // Reject very sparse regions (e.g., small text, doodles) while allowing stars/outlines
    if (fillRatio < 0.09 && !isLargeOutlineRect && !(solidity < 0.7 && hull.length === 5))
      return null;

    // Classify the shape
    const classification = this.classifyShape(simplified, area, perimeter, {
      fillRatio,
      solidity,
      hullArea,
      contourPixelArea,
      aspectRatio,
      boundingBox,
    });

    if (!classification) return null;

    // Use pixel-based area for highly concave shapes (e.g., stars) to improve area accuracy
    const outputArea = classification.type === "star" ? contourPixelArea : area;

    return {
      type: classification.type,
      confidence: classification.confidence,
      boundingBox: this.calculateBoundingBox(simplified),
      center,
      area: outputArea,
    };
  }

  /**
   * Calculate center of mass
   */
  private calculateCenter(points: Point[]): Point {
    let sumX = 0;
    let sumY = 0;

    for (const p of points) {
      sumX += p.x;
      sumY += p.y;
    }

    return {
      x: sumX / points.length,
      y: sumY / points.length,
    };
  }

  /**
   * Calculate bounding box
   */
  private calculateBoundingBox(
    points: Point[]
  ): { x: number; y: number; width: number; height: number } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;

    for (const p of points) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }

    return {
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
    };
  }

  /**
   * Calculate polygon area using shoelace formula
   */
  private calculateAreaPolygon(points: Point[]): number {
    if (points.length < 3) return 0;

    let area = 0;
    for (let i = 0; i < points.length; i++) {
      const j = (i + 1) % points.length;
      area += points[i].x * points[j].y;
      area -= points[j].x * points[i].y;
    }

    return Math.abs(area) / 2;
  }

  /**
   * Calculate perimeter
   */
  private calculatePerimeter(points: Point[]): number {
    if (points.length < 2) return 0;

    let perimeter = 0;
    for (let i = 0; i < points.length; i++) {
      const j = (i + 1) % points.length;
      const dx = points[j].x - points[i].x;
      const dy = points[j].y - points[i].y;
      perimeter += Math.sqrt(dx * dx + dy * dy);
    }

    return perimeter;
  }

  /**
   * Convex hull using Graham scan
   */
  private convexHull(points: Point[]): Point[] {
    if (points.length < 3) return points;

    // Sort points by x-coordinate
    const sorted = [...points].sort((a, b) => a.x - b.x || a.y - b.y);

    // Build lower hull
    const lower: Point[] = [];
    for (const p of sorted) {
      while (
        lower.length >= 2 &&
        this.crossProduct(lower[lower.length - 2], lower[lower.length - 1], p) <=
        0
      ) {
        lower.pop();
      }
      lower.push(p);
    }

    // Build upper hull
    const upper: Point[] = [];
    for (let i = sorted.length - 1; i >= 0; i--) {
      const p = sorted[i];
      while (
        upper.length >= 2 &&
        this.crossProduct(upper[upper.length - 2], upper[upper.length - 1], p) <=
        0
      ) {
        upper.pop();
      }
      upper.push(p);
    }

    // Concatenate hulls
    return lower.concat(upper.slice(0, -1));
  }

  /**
   * Calculate cross product for convex hull
   */
  private crossProduct(o: Point, a: Point, b: Point): number {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  }

  /**
   * Classify shape based on hull and contour properties
   */
  private classifyShape(
    hull: Point[],
    area: number,
    perimeter: number,
    metadata: {
      fillRatio: number;
      solidity: number;
      hullArea: number;
      contourPixelArea: number;
      aspectRatio: number;
      boundingBox: { x: number; y: number; width: number; height: number };
    }
  ): { type: DetectedShape["type"]; confidence: number } | null {
    const angles = this.calculateAngles(hull);
    const cornerCount = angles.filter((a) => a < 150).length;

    // Star detection: convex hull is a pentagon, but the filled area is much smaller than the hull (concave shape)
    if (hull.length === 5) {
      const solidity = metadata.solidity;
      if (solidity < 0.7 && metadata.contourPixelArea > 200) {
        return {
          type: "star",
          confidence: Math.min(0.95, 0.6 + (0.7 - solidity) * 0.4),
        };
      }
    }

    // Triangle: exactly 3 corners
    if (cornerCount === 3) {
      return {
        type: "triangle",
        confidence: 0.9,
      };
    }

    // Pentagon: exactly 5 corners and reasonably solid
    if (cornerCount === 5 && metadata.solidity > 0.75) {
      return {
        type: "pentagon",
        confidence: 0.85,
      };
    }

    // Rectangle/Square: exactly 4 corners
    if (cornerCount === 4) {
      const rightAngles = angles.filter((a) => Math.abs(a - 90) < 20).length;
      const confidence = rightAngles === 4 ? 0.95 : 0.75;

      const isLargeOutlineRect =
        metadata.fillRatio < 0.25 &&
        metadata.contourPixelArea > 1200 &&
        metadata.boundingBox.width > 40 &&
        metadata.boundingBox.height > 40;

      // Require reasonable fill ratio for rectangles to avoid picking up line-art,
      // but allow large outlines (clockwise rectangles drawn as strokes).
      if (metadata.fillRatio < 0.25 && !isLargeOutlineRect) return null;

      return {
        type: "rectangle",
        confidence,
      };
    }

    // Circle: fallback based on circularity (after polygon-based categories)
    const circularity = perimeter > 0 ? (4 * Math.PI * area) / (perimeter * perimeter) : 0;
    if (circularity > 0.75 && metadata.fillRatio > 0.4) {
      return {
        type: "circle",
        confidence: Math.min(0.99, 0.7 + circularity * 0.15),
      };
    }

    return null;
  }

  /**
   * Calculate angles at each vertex
   */
  private calculateAngles(polygon: Point[]): number[] {
    const angles: number[] = [];

    for (let i = 0; i < polygon.length; i++) {
      const prev = polygon[(i - 1 + polygon.length) % polygon.length];
      const curr = polygon[i];
      const next = polygon[(i + 1) % polygon.length];

      const v1 = { x: prev.x - curr.x, y: prev.y - curr.y };
      const v2 = { x: next.x - curr.x, y: next.y - curr.y };

      const dot = v1.x * v2.x + v1.y * v2.y;
      const det = v1.x * v2.y - v1.y * v2.x;
      let angle = Math.atan2(det, dot) * (180 / Math.PI);

      // Normalize to 0-180
      if (angle < 0) angle += 360;
      if (angle > 180) angle = 360 - angle;

      angles.push(angle);
    }

    return angles;
  }

  /**
   * Simplify a polygon using the Ramer-Douglas-Peucker algorithm
   */
  private simplifyPolygon(points: Point[], tolerance: number): Point[] {
    if (points.length < 3) return points;

    const sqTolerance = tolerance * tolerance;

    const simplifyDPStep = (pts: Point[], first: number, last: number, simplified: Point[]) => {
      let maxDistSq = 0;
      let index = 0;

      const firstPt = pts[first];
      const lastPt = pts[last];

      for (let i = first + 1; i < last; i++) {
        const distSq = this.getSquareSegmentDistance(pts[i], firstPt, lastPt);
        if (distSq > maxDistSq) {
          index = i;
          maxDistSq = distSq;
        }
      }

      if (maxDistSq > sqTolerance) {
        if (index - first > 1) simplifyDPStep(pts, first, index, simplified);
        simplified.push(pts[index]);
        if (last - index > 1) simplifyDPStep(pts, index, last, simplified);
      }
    };

    const simplified: Point[] = [points[0]];
    simplifyDPStep(points, 0, points.length - 1, simplified);
    simplified.push(points[points.length - 1]);

    return simplified;
  }

  /**
   * Get squared distance from a point to a segment
   */
  private getSquareSegmentDistance(p: Point, p1: Point, p2: Point): number {
    let x = p1.x;
    let y = p1.y;
    let dx = p2.x - x;
    let dy = p2.y - y;

    if (dx !== 0 || dy !== 0) {
      const t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy);
      if (t > 1) {
        x = p2.x;
        y = p2.y;
      } else if (t > 0) {
        x += dx * t;
        y += dy * t;
      }
    }

    dx = p.x - x;
    dy = p.y - y;

    return dx * dx + dy * dy;
  }

  loadImage(file: File): Promise<ImageData> {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        this.canvas.width = img.width;
        this.canvas.height = img.height;
        this.ctx.drawImage(img, 0, 0);
        const imageData = this.ctx.getImageData(0, 0, img.width, img.height);
        resolve(imageData);
      };
      img.onerror = reject;
      img.src = URL.createObjectURL(file);
    });
  }
}

class ShapeDetectionApp {
  private detector: ShapeDetector;
  private imageInput: HTMLInputElement;
  private resultsDiv: HTMLDivElement;
  private testImagesDiv: HTMLDivElement;
  private evaluateButton: HTMLButtonElement;
  private evaluationResultsDiv: HTMLDivElement;
  private selectionManager: SelectionManager;
  private evaluationManager: EvaluationManager;

  constructor() {
    const canvas = document.getElementById(
      "originalCanvas"
    ) as HTMLCanvasElement;
    this.detector = new ShapeDetector(canvas);

    this.imageInput = document.getElementById("imageInput") as HTMLInputElement;
    this.resultsDiv = document.getElementById("results") as HTMLDivElement;
    this.testImagesDiv = document.getElementById(
      "testImages"
    ) as HTMLDivElement;
    this.evaluateButton = document.getElementById(
      "evaluateButton"
    ) as HTMLButtonElement;
    this.evaluationResultsDiv = document.getElementById(
      "evaluationResults"
    ) as HTMLDivElement;

    this.selectionManager = new SelectionManager();
    this.evaluationManager = new EvaluationManager(
      this.detector,
      this.evaluateButton,
      this.evaluationResultsDiv
    );

    this.setupEventListeners();
    this.loadTestImages().catch(console.error);
  }

  private setupEventListeners(): void {
    this.imageInput.addEventListener("change", async (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) {
        await this.processImage(file);
      }
    });

    this.evaluateButton.addEventListener("click", async () => {
      const selectedImages = this.selectionManager.getSelectedImages();
      await this.evaluationManager.runSelectedEvaluation(selectedImages);
    });
  }

  private async processImage(file: File): Promise<void> {
    try {
      this.resultsDiv.innerHTML = "<p>Processing...</p>";

      const imageData = await this.detector.loadImage(file);
      const results = await this.detector.detectShapes(imageData);

      this.displayResults(results);
    } catch (error) {
      this.resultsDiv.innerHTML = `<p>Error: ${error}</p>`;
    }
  }

  private displayResults(results: DetectionResult): void {
    const { shapes, processingTime } = results;

    let html = `
      <p><strong>Processing Time:</strong> ${processingTime.toFixed(2)}ms</p>
      <p><strong>Shapes Found:</strong> ${shapes.length}</p>
    `;

    if (shapes.length > 0) {
      html += "<h4>Detected Shapes:</h4><ul>";
      shapes.forEach((shape) => {
        html += `
          <li>
            <strong>${shape.type.charAt(0).toUpperCase() + shape.type.slice(1)
          }</strong><br>
            Confidence: ${(shape.confidence * 100).toFixed(1)}%<br>
            Center: (${shape.center.x.toFixed(1)}, ${shape.center.y.toFixed(
            1
          )})<br>
            Area: ${shape.area.toFixed(1)}px²
          </li>
        `;
      });
      html += "</ul>";
    } else {
      html +=
        "<p>No shapes detected. Please implement the detection algorithm.</p>";
    }

    this.resultsDiv.innerHTML = html;
  }

  private async loadTestImages(): Promise<void> {
    try {
      const module = await import("./test-images-data.js");
      const testImages = module.testImages;
      const imageNames = module.getAllTestImageNames();

      let html =
        '<h4>Click to upload your own image or use test images for detection. Right-click test images to select/deselect for evaluation:</h4><div class="evaluation-controls"><button id="selectAllBtn">Select All</button><button id="deselectAllBtn">Deselect All</button><span class="selection-info">0 images selected</span></div><div class="test-images-grid">';

      // Add upload functionality as first grid item
      html += `
        <div class="test-image-item upload-item" onclick="triggerFileUpload()">
          <div class="upload-icon">📁</div>
          <div class="upload-text">Upload Image</div>
          <div class="upload-subtext">Click to select file</div>
        </div>
      `;

      imageNames.forEach((imageName) => {
        const dataUrl = testImages[imageName as keyof typeof testImages];
        const displayName = imageName
          .replace(/[_-]/g, " ")
          .replace(/\.(svg|png)$/i, "");
        html += `
          <div class="test-image-item" data-image="${imageName}" 
               onclick="loadTestImage('${imageName}', '${dataUrl}')" 
               oncontextmenu="toggleImageSelection(event, '${imageName}')">
            <img src="${dataUrl}" alt="${imageName}">
            <div>${displayName}</div>
          </div>
        `;
      });

      html += "</div>";
      this.testImagesDiv.innerHTML = html;

      this.selectionManager.setupSelectionControls();

      (window as any).loadTestImage = async (name: string, dataUrl: string) => {
        try {
          const response = await fetch(dataUrl);
          const blob = await response.blob();
          const file = new File([blob], name, { type: "image/svg+xml" });

          const imageData = await this.detector.loadImage(file);
          const results = await this.detector.detectShapes(imageData);
          this.displayResults(results);

          console.log(`Loaded test image: ${name}`);
        } catch (error) {
          console.error("Error loading test image:", error);
        }
      };

      (window as any).toggleImageSelection = (
        event: MouseEvent,
        imageName: string
      ) => {
        event.preventDefault();
        this.selectionManager.toggleImageSelection(imageName);
      };

      // Add upload functionality
      (window as any).triggerFileUpload = () => {
        this.imageInput.click();
      };
    } catch (error) {
      this.testImagesDiv.innerHTML = `
        <p>Test images not available. Run 'node convert-svg-to-png.js' to generate test image data.</p>
        <p>SVG files are available in the test-images/ directory.</p>
      `;
    }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  new ShapeDetectionApp();
});

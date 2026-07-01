/// <reference types="vite/client" />

// BarcodeDetector isn't yet in TypeScript's bundled DOM lib — minimal ambient
// declaration for the subset used by the barcode-scanning feature (see
// BarcodeAddModal in src/ui/App.tsx). Real API:
// https://developer.mozilla.org/en-US/docs/Web/API/BarcodeDetector
interface DetectedBarcode {
  rawValue: string;
}

declare class BarcodeDetector {
  constructor(options?: { formats?: string[] });
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>;
}

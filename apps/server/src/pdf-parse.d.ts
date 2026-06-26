declare module 'pdf-parse' {
  const pdfParse: (dataBuffer: Buffer) => Promise<{
    numpages?: number;
    numrender?: number;
    info?: Record<string, unknown>;
    metadata?: unknown;
    text?: string;
    html?: string;
    version?: string;
  }>;
  export default pdfParse;
}

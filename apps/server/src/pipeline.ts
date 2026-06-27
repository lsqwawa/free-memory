import fs from 'node:fs/promises';
import path from 'node:path';
import * as cheerio from 'cheerio';
import { pool } from './db';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type ProcessInput = {
  userId: string;
  documentId: string;
  filePath: string;
};

type KnowledgeDraft = {
  title: string;
  contentText: string;
  contentHtml: string;
  colorType: 'red' | 'blue';
  pageFrom: number | null;
  pageTo: number | null;
};

type BlankDraft = {
  originalText: string;
  normalizedAnswer: string;
  colorType: 'red' | 'blue';
};

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

const MAX_BLANKS_PER_POINT = 2;
const BLANK_MIN_LENGTH = 2;
const BLANK_MAX_LENGTH = 16;

/** Lines shorter than this are ignored entirely. */
const MIN_LINE_LENGTH = 2;

/** Fraction of pages a line must appear on to be considered a header/footer. */
const HEADER_FOOTER_THRESHOLD = 0.4;

/** Top/bottom margin ratio — text items within this band are header/footer candidates. */
const TOP_BAND = 0.08;
const BOTTOM_BAND = 0.92;

/* ------------------------------------------------------------------ */
/*  Per-page text extraction with Y-position metadata                  */
/* ------------------------------------------------------------------ */

type TextItem = { str: string; transform: number[]; width: number; height: number };

type PageLine = {
  text: string;
  /** 0 = top of page, 1 = bottom */
  yRatio: number;
};

async function extractPagesRaw(buffer: Buffer): Promise<{ numPages: number; pages: PageLine[][] }> {
  // Dynamically require pdf.js from pdf-parse's bundled copy
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // @ts-ignore -- using pdf-parse bundled pdf.js
  const pdfjs: any = require('pdf-parse/lib/pdf.js/v1.10.100/build/pdf.js');
  pdfjs.disableWorker = true;

  const doc = await pdfjs.getDocument(buffer);
  const numPages: number = doc.numPages;
  const pages: PageLine[][] = [];

  for (let i = 1; i <= numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1.0 });
    const pageHeight = viewport.height;

    const textContent = await page.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
    const items = textContent.items as TextItem[];

    // Group items by Y coordinate (same line)
    const lineMap = new Map<number, string[]>();
    for (const item of items) {
      if (!item.str || !item.str.trim()) continue;
      // transform[5] is the Y position from the bottom
      const y = Math.round(item.transform[5]);
      if (!lineMap.has(y)) lineMap.set(y, []);
      lineMap.get(y)!.push(item.str);
    }

    // Sort by Y descending (top of page first, since pdf.js Y is from bottom)
    const sortedYs = Array.from(lineMap.keys()).sort((a, b) => b - a);

    const pageLines: PageLine[] = sortedYs.map((y) => {
      const text = collapseWhitespace(lineMap.get(y)!.join(' '));
      const yRatio = pageHeight > 0 ? 1 - y / pageHeight : 0.5;
      return { text, yRatio };
    });

    pages.push(pageLines);
  }

  doc.destroy();
  return { numPages, pages };
}

/* ------------------------------------------------------------------ */
/*  Header / footer detection & removal                                */
/* ------------------------------------------------------------------ */

function filterHeadersAndFooters(pages: PageLine[][]): string[][] {
  if (pages.length === 0) return [];

  // Count how many pages each unique line appears on
  const linePageCount = new Map<string, Set<number>>();

  for (let pi = 0; pi < pages.length; pi++) {
    const seen = new Set<string>();
    for (const line of pages[pi]) {
      const normalized = normalizeForComparison(line.text);
      if (!normalized) continue;

      // Only consider lines in the top or bottom band as header/footer candidates
      if (line.yRatio < TOP_BAND || line.yRatio > BOTTOM_BAND) {
        if (!seen.has(normalized)) {
          seen.add(normalized);
          if (!linePageCount.has(normalized)) linePageCount.set(normalized, new Set());
          linePageCount.get(normalized)!.add(pi);
        }
      }
    }
  }

  // Build set of lines that appear on enough pages to be headers/footers
  const headerFooterLines = new Set<string>();
  for (const [normalized, pageSet] of linePageCount) {
    if (pageSet.size >= Math.max(2, pages.length * HEADER_FOOTER_THRESHOLD)) {
      headerFooterLines.add(normalized);
    }
  }

  // Filter out header/footer lines from all pages
  return pages.map((pageLines) =>
    pageLines
      .filter((line) => {
        const normalized = normalizeForComparison(line.text);
        // Remove if it's a detected header/footer
        if (headerFooterLines.has(normalized)) return false;
        // Remove if it's in margin zone and very short (likely page number, date, etc.)
        if ((line.yRatio < TOP_BAND || line.yRatio > BOTTOM_BAND) && line.text.replace(/\s/g, '').length <= 8) return false;
        return true;
      })
      .map((line) => line.text),
  );
}

function normalizeForComparison(text: string): string {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\d+/g, '#') // Replace numbers so "Page 1" matches "Page 2"
    .trim()
    .toLowerCase();
}

/* ------------------------------------------------------------------ */
/*  Content extraction: identify key knowledge points                   */
/* ------------------------------------------------------------------ */

function extractKnowledgeFromPages(cleanedPages: string[][]): KnowledgeDraft[] {
  const results: KnowledgeDraft[] = [];

  for (let pageIndex = 0; pageIndex < cleanedPages.length; pageIndex++) {
    const pageNum = pageIndex + 1;
    const pageLines = cleanedPages[pageIndex];

    // Join consecutive lines into paragraphs
    const paragraphs = buildParagraphs(pageLines);

    for (const para of paragraphs) {
      if (!isUsefulContent(para)) continue;

      const title = extractSectionTitle(para) || `第${pageNum}页 重点内容`;
      results.push({
        title,
        contentText: para,
        contentHtml: `<p>${escapeHtml(para)}</p>`,
        colorType: results.length % 2 === 0 ? 'red' : 'blue',
        pageFrom: pageNum,
        pageTo: pageNum,
      });
    }
  }

  // Deduplicate
  return deduplicateKnowledgeDrafts(results);
}

/** Merge consecutive non-empty lines into paragraphs. */
function buildParagraphs(lines: string[]): string[] {
  const paragraphs: string[] = [];
  let current: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (current.length > 0) {
        paragraphs.push(collapseWhitespace(current.join(' ')));
        current = [];
      }
      continue;
    }
    current.push(trimmed);
  }
  if (current.length > 0) {
    paragraphs.push(collapseWhitespace(current.join(' ')));
  }

  return paragraphs;
}

/** Determine if a paragraph contains meaningful content worth studying. */
function isUsefulContent(text: string): boolean {
  const normalized = text.replace(/\s+/g, '');
  // Too short
  if (normalized.length < 8) return false;
  // Must contain meaningful characters
  const meaningfulChars = (normalized.match(/[\u4e00-\u9fa5a-zA-Z0-9]/g) || []).length;
  if (meaningfulChars < 6) return false;
  // Skip lines that are mostly punctuation or symbols
  const punctRatio = (normalized.match(/[^\u4e00-\u9fa5a-zA-Z0-9]/g) || []).length / normalized.length;
  if (punctRatio > 0.6) return false;
  return true;
}

/** Try to extract a section title from the beginning of a paragraph. */
function extractSectionTitle(text: string): string {
  // Match patterns like "一、", "1.", "第一章", "(一)", "【重点】", etc.
  const titlePatterns = [
    /^[一二三四五六七八九十]+[、.．]\s*(.{1,30})/,
    /^第[一二三四五六七八九十\d]+[章节篇]\s*(.{0,30})/,
    /^\d+[.、）)]\s*(.{1,30})/,
    /^[（(][一二三四五六七八九十\d]+[）)]\s*(.{1,30})/,
    /^【[^】]{1,20}】/,
    /^(?:重点|要点|核心|关键|注意|提示)[：:]\s*(.{1,30})/,
  ];

  for (const pattern of titlePatterns) {
    const match = text.match(pattern);
    if (match) {
      const title = collapseWhitespace(match[0]);
      if (title.length <= 50) return title;
    }
  }

  // Fallback: take first clause (up to first punctuation)
  const firstClause = text.match(/^[^，。；！？\n]{4,30}/);
  if (firstClause) {
    return firstClause[0].trim();
  }

  return '';
}

/* ------------------------------------------------------------------ */
/*  Main entry point                                                   */
/* ------------------------------------------------------------------ */

export async function processDocumentAndGenerateQuestions(input: ProcessInput) {
  const buffer = await fs.readFile(input.filePath);

  // Step 1: Extract per-page text with Y-position metadata
  const { numPages, pages } = await extractPagesRaw(buffer);

  await pool.query(
    `update documents set page_count = $1, updated_at = now() where id = $2`,
    [numPages, input.documentId],
  );

  // Step 2: Detect and remove headers/footers
  const cleanedPages = filterHeadersAndFooters(pages);

  // Step 3: Extract knowledge points from cleaned content
  const knowledgeDrafts = extractKnowledgeFromPages(cleanedPages);

  // Step 4: Store in database
  const client = await pool.connect();
  try {
    await client.query('begin');

    let knowledgePointCount = 0;
    let blankSlotCount = 0;
    let questionCount = 0;

    for (let index = 0; index < knowledgeDrafts.length; index++) {
      const draft = knowledgeDrafts[index];
      const kp = await client.query<{ id: string }>(
        `insert into knowledge_points
           (id, document_id, user_id, page_from, page_to, section_title, content_text, content_html, order_index)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8)
         returning id`,
        [
          input.documentId,
          input.userId,
          draft.pageFrom,
          draft.pageTo,
          draft.title,
          draft.contentText,
          draft.contentHtml,
          index + 1,
        ],
      );
      const knowledgePointId = kp.rows[0].id;
      knowledgePointCount += 1;

      const blanks = buildBlankDraftsFromText(draft.contentText, draft.colorType);
      let blankIndex = 0;

      for (const blank of blanks) {
        if (blankIndex >= MAX_BLANKS_PER_POINT) break;

        const slot = await client.query<{ id: string }>(
          `insert into blank_slots
             (id, knowledge_point_id, original_text, normalized_answer, color_type, char_start, char_end, order_index)
           values (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7)
           returning id`,
          [
            knowledgePointId,
            blank.originalText,
            blank.normalizedAnswer,
            blank.colorType,
            null,
            null,
            blankIndex + 1,
          ],
        );
        const blankSlotId = slot.rows[0].id;
        blankSlotCount += 1;
        blankIndex += 1;

        const stemText = draft.contentText.replace(blank.originalText, '____');
        const stemHtml = escapeHtml(draft.contentText).replace(escapeHtml(blank.originalText), '<strong>____</strong>');

        const q = await client.query<{ id: string }>(
          `insert into questions
             (id, knowledge_point_id, stem_html, stem_text, difficulty, status)
           values (gen_random_uuid(), $1, $2, $3, 1, 'active')
           returning id`,
          [knowledgePointId, stemHtml, stemText],
        );
        const questionId = q.rows[0].id;
        questionCount += 1;

        await client.query(
          `insert into question_blanks
             (id, question_id, blank_slot_id, position_index, answer_text, answer_variants)
           values (gen_random_uuid(), $1, $2, 1, $3, $4)`,
          [questionId, blankSlotId, blank.normalizedAnswer, [blank.originalText, blank.normalizedAnswer]],
        );
      }
    }

    await client.query(
      `update documents set status = 'parsed', updated_at = now() where id = $1`,
      [input.documentId],
    );

    await client.query('commit');
    return { knowledgePointCount, blankSlotCount, questionCount };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/*  Blank generation helpers                                           */
/* ------------------------------------------------------------------ */

function buildBlankDraftsFromText(text: string, colorType: 'red' | 'blue'): BlankDraft[] {
  const candidates = text
    .split(/[，,。；;：:\n]/)
    .map((part) => collapseWhitespace(part))
    .filter((part) => part.length >= BLANK_MIN_LENGTH && part.length <= BLANK_MAX_LENGTH)
    .filter((part) => /[\u4e00-\u9fa5a-zA-Z0-9]/.test(part));

  const unique = Array.from(new Set(candidates));
  return unique.slice(0, MAX_BLANKS_PER_POINT).map((candidate) => ({
    originalText: candidate,
    normalizedAnswer: normalizeAnswer(candidate),
    colorType,
  }));
}

/* ------------------------------------------------------------------ */
/*  String utilities                                                   */
/* ------------------------------------------------------------------ */

function collapseWhitespace(text: string) {
  return text.replace(/\s+/g, ' ').replace(/\s([,.;:!?，。；：！？])/g, '$1').trim();
}

function normalizeAnswer(text: string) {
  return text.replace(/\s+/g, '').replace(/^[,.;:!?，。；：！？]+|[,.;:!?，。；：！？]+$/g, '');
}

function deduplicateKnowledgeDrafts(items: KnowledgeDraft[]) {
  const seen = new Set<string>();
  const result: KnowledgeDraft[] = [];

  for (const item of items) {
    const key = item.contentText;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }

  return result.slice(0, 200);
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}



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


/* ------------------------------------------------------------------ */
/*  Generate blanks for a single knowledge point (API)                 */
/* ------------------------------------------------------------------ */

export async function generateBlanksForKnowledgePoint(
  knowledgePointId: string,
  contentText: string,
) {
  const blanks = buildBlankDraftsFromText(contentText, 'red');
  const client = await pool.connect();

  try {
    await client.query('begin');

    // Delete existing blanks and questions for this KP
    await client.query(
      'delete from question_blanks where question_id in (select id from questions where knowledge_point_id = $1)',
      [knowledgePointId],
    );
    await client.query('delete from questions where knowledge_point_id = $1', [knowledgePointId]);
    await client.query('delete from blank_slots where knowledge_point_id = $1', [knowledgePointId]);

    let blankSlotCount = 0;
    let questionCount = 0;

    if (blanks.length > 0) {
      let stemText = contentText;
      let stemHtml = escapeHtml(contentText);

      for (const blank of blanks) {
        stemText = stemText.replace(blank.originalText, '____');
        stemHtml = stemHtml.replace(escapeHtml(blank.originalText), '<strong>____</strong>');
      }

      const q = await client.query<{ id: string }>(
        "insert into questions (id, knowledge_point_id, stem_html, stem_text, difficulty, status) values (gen_random_uuid(), $1, $2, $3, 1, 'active') returning id",
        [knowledgePointId, stemHtml, stemText],
      );
      const questionId = q.rows[0].id;
      questionCount = 1;

      for (let bi = 0; bi < blanks.length; bi++) {
        const blank = blanks[bi];
        const slot = await client.query<{ id: string }>(
          "insert into blank_slots (id, knowledge_point_id, original_text, normalized_answer, color_type, char_start, char_end, order_index) values (gen_random_uuid(), $1, $2, $3, 'red', $4, $5, $6) returning id",
          [knowledgePointId, blank.originalText, blank.normalizedAnswer, null, null, bi + 1],
        );
        blankSlotCount += 1;

        await client.query(
          'insert into question_blanks (id, question_id, blank_slot_id, position_index, answer_text, answer_variants) values (gen_random_uuid(), $1, $2, $3, $4, $5)',
          [questionId, slot.rows[0].id, bi + 1, blank.normalizedAnswer, [blank.originalText, blank.normalizedAnswer]],
        );
      }
    }

    await client.query('commit');
    return { blankSlotCount, questionCount };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/*  User manual blank creation                                         */
/* ------------------------------------------------------------------ */

export async function createUserBlank(
  knowledgePointId: string,
  contentText: string,
  selectedText: string,
) {
  const normalizedAnswer = selectedText.trim().replace(/\s+/g, '').replace(/^[,.;:!?，。；：！？]+|[,.;:!?，。；：！？]+$/g, '');
  if (!normalizedAnswer || normalizedAnswer.length < 2) {
    throw new Error('选中文本太短，至少需要2个字符');
  }

  const client = await pool.connect();
  try {
    await client.query('begin');

    const countRes = await client.query<{ cnt: number }>(
      'select count(*)::int as cnt from blank_slots where knowledge_point_id = $1',
      [knowledgePointId],
    );
    const nextIndex = countRes.rows[0].cnt + 1;

    const slot = await client.query<{ id: string }>(
      "insert into blank_slots (id, knowledge_point_id, original_text, normalized_answer, color_type, char_start, char_end, order_index) values (gen_random_uuid(), $1, $2, $3, 'red', $4, $5, $6) returning id",
      [knowledgePointId, selectedText.trim(), normalizedAnswer, null, null, nextIndex],
    );
    const blankSlotId = slot.rows[0].id;

    const stemText = contentText.replace(selectedText.trim(), '____');
    const stemHtml = escapeHtml(contentText).replace(escapeHtml(selectedText.trim()), '<strong>____</strong>');

    const q = await client.query<{ id: string }>(
      "insert into questions (id, knowledge_point_id, stem_html, stem_text, difficulty, status) values (gen_random_uuid(), $1, $2, $3, 1, 'active') returning id",
      [knowledgePointId, stemHtml, stemText],
    );

    await client.query(
      'insert into question_blanks (id, question_id, blank_slot_id, position_index, answer_text, answer_variants) values (gen_random_uuid(), $1, $2, 1, $3, $4)',
      [q.rows[0].id, blankSlotId, normalizedAnswer, [selectedText.trim(), normalizedAnswer]],
    );

    await client.query('commit');
    return { blankSlotId, questionId: q.rows[0].id };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

function escapeHtml(text: string) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}


/* ------------------------------------------------------------------ */
/*  Text input processing                                              */
/* ------------------------------------------------------------------ */

/**
 * Process plain text input (from user typing/pasting) and generate knowledge points + questions.
 */

/* ------------------------------------------------------------------ */
/*  MiMo AI Knowledge Point Extraction                                 */
/* ------------------------------------------------------------------ */

interface AiExtractedPoint {
  title: string;
  content: string;
  blanks: string[];
}

const MIMO_API_URL_CONST = 'https://api.xiaomimimo.com/v1/chat/completions';

async function aiExtractKnowledgePoints(fullText: string, apiKey: string): Promise<KnowledgeDraft[] | null> {
  if (!apiKey) return null;

  const maxChars = 15000;
  const truncated = fullText.length > maxChars ? fullText.slice(0, maxChars) + '\n...(内容过长已截断)' : fullText;

  const prompt = `你是一名公务员考试/事业编考试辅导专家。请分析以下备考资料，提取出所有需要记忆和理解的知识点。

## 任务要求

1. **按序号拆分（最重要）**：如果原文中有编号（如1. 2. 3. 或一、二、三、或(1)(2)(3)或①②③），必须严格按照编号拆分，每个编号对应一个独立的知识点。编号格式包括但不限于：阿拉伯数字序号（1. 2. 3.）、中文序号（一、二、三、）、括号序号（(1)(2)或（一）（二））、圈号（①②③）。
2. **知识点拆分**：如果没有明显编号，则将内容拆分为独立、完整的知识点单元。每个知识点应该是"一个需要记住的核心事实或规则"。
3. **标题**：以序号作为标题前缀（如"1. 行政处罚法"、"二、行政复议范围"），再加上简短的总结性短语（不超过20字）。
4. **内容**：保留知识点的完整原文表述，不要遗漏关键细节（如数字、年限、比例、条件等）。
5. **填空（必须）**：每个知识点必须至少提供1个填空关键词，最多3个。要求：
   - 该术语是该知识点中最核心、最容易遗忘的关键词
   - 优先选择：专有名词、数字、法律名称《》、政策名称、时间节点、百分比、具体条件、法律术语（如"行政复议"、"行政处罚"）
   - 每个关键词长度 2-20 个字
   - 去掉后能通过上下文推断
6. **忽略**：页眉页脚、页码、目录索引、章节分隔符、页码标注等无意义内容。

## 输出格式

严格返回以下 JSON，不要包含任何其他文字、解释或 markdown 标记：

{"points":[{"title":"知识点标题","content":"知识点完整原文内容","blanks":["填空关键词1","填空关键词2"]}]}

## 备考资料内容

${truncated}`;

  try {
    const response = await fetch(MIMO_API_URL_CONST, {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'mimo-v2.5-pro',
        messages: [
          { role: 'system', content: '你是公考辅导领域的 AI 助手。你的任务是从备考资料中精准提取知识点并生成高质量填空题。你只输出合法的 JSON，不输出任何多余内容。' },
          { role: 'user', content: prompt },
        ],
        max_completion_tokens: 4096,
        temperature: 0.2,
        top_p: 0.9,
        stream: false,
      }),
    });

    if (!response.ok) {
      console.error('MiMo API error:', response.status, await response.text());
      return null;
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) return null;

    let jsonStr = content.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) jsonStr = jsonMatch[1].trim();
    const braceStart = jsonStr.indexOf('{');
    const braceEnd = jsonStr.lastIndexOf('}');
    if (braceStart >= 0 && braceEnd > braceStart) jsonStr = jsonStr.slice(braceStart, braceEnd + 1);

    const parsed = JSON.parse(jsonStr);
    if (!parsed.points || !Array.isArray(parsed.points)) return null;

    return parsed.points
      .filter((p: any) => p.title && p.content && p.content.length > 10)
      .map((p: any) => ({
        title: p.title.slice(0, 50),
        contentText: p.content,
        contentHtml: '<p>' + p.content.replace(/</g, '&lt;').replace(/>/g, '&gt;') + '</p>',
        pageFrom: null,
        pageTo: null,
      }));
  } catch (err) {
    console.error('MiMo AI extraction failed:', err);
    return null;
  }
}

export async function processTextAndGenerateQuestions(input: {
  userId: string;
  documentId: string;
  textContent: string;
}) {
  const rawLines = input.textContent.split(/\n/).map(l => l.trim());

  // Try AI extraction first
  let knowledgeDrafts: KnowledgeDraft[] = [];
  const mimoApiKey = process.env.MIMO_API_KEY || '';

  if (mimoApiKey && input.textContent.length > 50) {
    console.log('Attempting MiMo AI extraction for text input...');
    const aiResult = await aiExtractKnowledgePoints(input.textContent, mimoApiKey);
    if (aiResult && aiResult.length > 0) {
      console.log(`MiMo AI extracted ${aiResult.length} knowledge points from text`);
      knowledgeDrafts = aiResult;
    }
  }

  // Fallback to rule-based
  if (knowledgeDrafts.length === 0) {
    const cleanedPages: string[][] = [rawLines.filter(l => l.length > 0)];
    knowledgeDrafts = extractKnowledgeFromPages(cleanedPages);
  }

  // Store to database
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
        [input.documentId, input.userId, draft.pageFrom, draft.pageTo, draft.title, draft.contentText, draft.contentHtml, index + 1],
      );
      const knowledgePointId = kp.rows[0].id;
      knowledgePointCount += 1;

      const blanks = buildBlankDraftsFromText(draft.contentText, 'red');
      if (blanks.length === 0) continue;

      let stemText = draft.contentText;
      let stemHtml = escapeHtml(draft.contentText);
      for (const blank of blanks) {
        stemText = stemText.replace(blank.originalText, '____');
        stemHtml = stemHtml.replace(escapeHtml(blank.originalText), '<strong>____</strong>');
      }

      const q = await client.query<{ id: string }>(
        `insert into questions (id, knowledge_point_id, stem_html, stem_text, difficulty, status)
         values (gen_random_uuid(), $1, $2, $3, 1, 'active') returning id`,
        [knowledgePointId, stemHtml, stemText],
      );
      const questionId = q.rows[0].id;
      questionCount += 1;

      for (let bi = 0; bi < blanks.length; bi++) {
        const blank = blanks[bi];
        const slot = await client.query<{ id: string }>(
          `insert into blank_slots (id, knowledge_point_id, original_text, normalized_answer, color_type, char_start, char_end, order_index)
           values (gen_random_uuid(), $1, $2, $3, 'red', $4, $5, $6) returning id`,
          [knowledgePointId, blank.originalText, blank.normalizedAnswer, null, null, bi + 1],
        );
        blankSlotCount += 1;

        await client.query(
          `insert into question_blanks (id, question_id, blank_slot_id, position_index, answer_text, answer_variants)
           values (gen_random_uuid(), $1, $2, $3, $4, $5)`,
          [questionId, slot.rows[0].id, bi + 1, blank.normalizedAnswer, [blank.originalText, blank.normalizedAnswer]],
        );
      }
    }

    await client.query(
      `update documents set status = 'parsed', page_count = 1, updated_at = now() where id = $1`,
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
/*  Image OCR with MiMo                                                */
/* ------------------------------------------------------------------ */

const MIMO_OMNI_MODEL = 'mimo-v2-omni';

async function ocrImageWithMiMo(imageBase64: string, apiKey: string): Promise<string> {
  const dataUrl = `data:image/png;base64,${imageBase64}`;

  const response = await fetch('https://api.xiaomimimo.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MIMO_OMNI_MODEL,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: '请仔细识别这张图片中的所有文字内容，保持原文的段落结构和序号格式，完整输出图片中的文字。如果是备考资料（公务员考试/事业编考试），请保留所有知识点、要点、定义、法规条文等关键信息。只输出识别到的文字内容，不要添加额外解释。',
            },
            {
              type: 'image_url',
              image_url: { url: dataUrl },
            },
          ],
        },
      ],
      max_completion_tokens: 4096,
      temperature: 0.1,
      stream: false,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`MiMo OCR API error: ${response.status} ${errText}`);
  }

  const data = (await response.json()) as {
    choices?: { message?: { content?: string } }[];
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error('MiMo OCR returned empty content');

  return content.trim();
}

/* ------------------------------------------------------------------ */
/*  Image upload processing                                            */
/* ------------------------------------------------------------------ */

export async function processImageAndGenerateQuestions(input: {
  userId: string;
  documentId: string;
  imageBase64: string;
}) {
  const mimoApiKey = process.env.MIMO_API_KEY || '';
  if (!mimoApiKey) throw new Error('MIMO_API_KEY not configured');

  // Step 1: OCR the image
  console.log('OCR-ing image with MiMo mimo-v2-omni...');
  const ocrText = await ocrImageWithMiMo(input.imageBase64, mimoApiKey);
  console.log(`OCR extracted ${ocrText.length} characters from image`);

  if (!ocrText || ocrText.length < 10) {
    throw new Error('Image OCR did not find enough text content');
  }

  // Step 2: Extract knowledge points from OCR text using AI
  let knowledgeDrafts: KnowledgeDraft[] = [];

  const aiResult = await aiExtractKnowledgePoints(ocrText, mimoApiKey);
  if (aiResult && aiResult.length > 0) {
    console.log(`MiMo AI extracted ${aiResult.length} knowledge points from image OCR`);
    knowledgeDrafts = aiResult;
  }

  // Fallback to rule-based
  if (knowledgeDrafts.length === 0) {
    const lines = ocrText.split(/\n/).map(l => l.trim()).filter(l => l.length > 0);
    const cleanedPages: string[][] = [lines];
    knowledgeDrafts = extractKnowledgeFromPages(cleanedPages);
  }

  // Store to database
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
        [input.documentId, input.userId, draft.pageFrom, draft.pageTo, draft.title, draft.contentText, draft.contentHtml, index + 1],
      );
      const knowledgePointId = kp.rows[0].id;
      knowledgePointCount += 1;

      const blanks = buildBlankDraftsFromText(draft.contentText, 'red');
      if (blanks.length === 0) continue;

      let stemText = draft.contentText;
      let stemHtml = escapeHtml(draft.contentText);
      for (const blank of blanks) {
        stemText = stemText.replace(blank.originalText, '____');
        stemHtml = stemHtml.replace(escapeHtml(blank.originalText), '<strong>____</strong>');
      }

      const q = await client.query<{ id: string }>(
        `insert into questions (id, knowledge_point_id, stem_html, stem_text, difficulty, status)
         values (gen_random_uuid(), $1, $2, $3, 1, 'active') returning id`,
        [knowledgePointId, stemHtml, stemText],
      );
      const questionId = q.rows[0].id;
      questionCount += 1;

      for (let bi = 0; bi < blanks.length; bi++) {
        const blank = blanks[bi];
        const slot = await client.query<{ id: string }>(
          `insert into blank_slots (id, knowledge_point_id, original_text, normalized_answer, color_type, char_start, char_end, order_index)
           values (gen_random_uuid(), $1, $2, $3, 'red', $4, $5, $6) returning id`,
          [knowledgePointId, blank.originalText, blank.normalizedAnswer, null, null, bi + 1],
        );
        blankSlotCount += 1;

        await client.query(
          `insert into question_blanks (id, question_id, blank_slot_id, position_index, answer_text, answer_variants)
           values (gen_random_uuid(), $1, $2, $3, $4, $5)`,
          [questionId, slot.rows[0].id, bi + 1, blank.normalizedAnswer, [blank.originalText, blank.normalizedAnswer]],
        );
      }
    }

    await client.query(
      `update documents set status = 'parsed', page_count = 1, updated_at = now() where id = $1`,
      [input.documentId],
    );

    await client.query('commit');
    return { knowledgePointCount, blankSlotCount, questionCount, ocrText };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

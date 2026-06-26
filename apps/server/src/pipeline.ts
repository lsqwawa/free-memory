import fs from 'node:fs/promises';
import path from 'node:path';
import pdfParse from 'pdf-parse';
import * as cheerio from 'cheerio';
import { pool } from './db';

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

const MAX_BLANKS_PER_POINT = 2;
const BLANK_MIN_LENGTH = 2;
const BLANK_MAX_LENGTH = 16;

export async function processDocumentAndGenerateQuestions(input: ProcessInput) {
  const buffer = await fs.readFile(input.filePath);
  const parsed = await (pdfParse as unknown as (dataBuffer: Buffer) => Promise<{ numpages?: number; html?: string; text?: string }>)(buffer);
  const pageCount = parsed.numpages ?? null;

  await pool.query(
    `update documents set page_count = $1, updated_at = now() where id = $2`,
    [pageCount, input.documentId]
  );

  const htmlText: string = parsed.html ?? '';
  const rawText: string = parsed.text ?? '';

  const knowledgeDrafts = extractKnowledgeDrafts(htmlText, rawText);

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
        ]
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
          ]
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
          [knowledgePointId, stemHtml, stemText]
        );
        const questionId = q.rows[0].id;
        questionCount += 1;

        await client.query(
          `insert into question_blanks
             (id, question_id, blank_slot_id, position_index, answer_text, answer_variants)
           values (gen_random_uuid(), $1, $2, 1, $3, $4)`,
          [questionId, blankSlotId, blank.normalizedAnswer, [blank.originalText, blank.normalizedAnswer]]
        );
      }
    }

    await client.query(
      `update documents set status = 'parsed', updated_at = now() where id = $1`,
      [input.documentId]
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

function extractKnowledgeDrafts(htmlText: string, rawText: string): KnowledgeDraft[] {
  const fromHtml = extractFromHtml(htmlText);
  if (fromHtml.length > 0) return fromHtml;
  return extractFromPlainText(rawText);
}

function extractFromHtml(html: string): KnowledgeDraft[] {
  if (!html) return [];
  const $ = cheerio.load(html);
  const results: KnowledgeDraft[] = [];

  $('body')
    .find('*')
    .each((_, el) => {
      const node = $(el);
      const color = normalizeColor(node.css('color'));
      if (!color) return;

      const text = collapseWhitespace(node.text());
      if (!isUsefulSentence(text)) return;

      const title = findHeadingText(node) || `${color === 'red' ? '红色重点' : '蓝色重点'}片段`;

      results.push({
        title,
        contentText: text,
        contentHtml: $.html(node),
        colorType: color,
        pageFrom: null,
        pageTo: null,
      });
    });

  return deduplicateKnowledgeDrafts(results);
}

function extractFromPlainText(rawText: string): KnowledgeDraft[] {
  const normalized = normalizeNewlines(rawText);
  const blocks = normalized
    .split(/\n{2,}/)
    .map((block) => collapseWhitespace(block))
    .filter((block) => isUsefulSentence(block));

  return blocks.map((block, index) => ({
    title: `重点片段 ${index + 1}`,
    contentText: block,
    contentHtml: `<p>${escapeHtml(block)}</p>`,
    colorType: index % 2 === 0 ? 'red' as const : 'blue' as const,
    pageFrom: null,
    pageTo: null,
  }));
}

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

function normalizeColor(value: string | undefined): 'red' | 'blue' | null {
  if (!value) return null;
  const c = value.trim().toLowerCase();
  if (isRedColor(c)) return 'red';
  if (isBlueColor(c)) return 'blue';
  return null;
}

function isRedColor(c: string) {
  return (
    c === 'red' ||
    c === '#f00' ||
    c === '#ff0000' ||
    c === 'rgb(255,0,0)' ||
    c === 'rgb(255, 0, 0)' ||
    c.includes('255, 0, 0') ||
    c.includes('192, 0, 0') ||
    c.includes('204, 0, 0') ||
    c.includes('231, 76, 60') ||
    c.includes('255, 87, 51')
  );
}

function isBlueColor(c: string) {
  return (
    c === 'blue' ||
    c === '#00f' ||
    c === '#0000ff' ||
    c === '#0070c0' ||
    c === 'rgb(0,0,255)' ||
    c === 'rgb(0, 0, 255)' ||
    c.includes('0, 0, 255') ||
    c.includes('0, 112, 192') ||
    c.includes('37, 99, 235') ||
    c.includes('59, 130, 246')
  );
}

function isUsefulSentence(text: string) {
  const normalized = text.replace(/\s+/g, '');
  if (normalized.length < 6) return false;
  const letterCount = (normalized.match(/[\u4e00-\u9fa5a-zA-Z0-9]/g) || []).length;
  return letterCount >= 4;
}

function collapseWhitespace(text: string) {
  return text.replace(/\s+/g, ' ').replace(/\s([,.;:!?，。；：！？])/g, '$1').trim();
}

function normalizeNewlines(text: string) {
  return text.replace(/\r\n?/g, '\n');
}

function normalizeAnswer(text: string) {
  return text.replace(/\s+/g, '').replace(/^[,.;:!?，。；：！？]+|[,.;:!?，。；：！？]+$/g, '');
}

function findHeadingText(node: ReturnType<ReturnType<typeof cheerio.load>>) {
  const prev = node.prevAll('h1,h2,h3,h4,h5,h6,p,strong,b').first();
  const text = collapseWhitespace(prev.text());
  return text.length <= 30 ? text : '';
}

function deduplicateKnowledgeDrafts(items: KnowledgeDraft[]) {
  const seen = new Set<string>();
  const result: KnowledgeDraft[] = [];

  for (const item of items) {
    const key = `${item.colorType}::${item.contentText}`;
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

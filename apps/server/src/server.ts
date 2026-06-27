import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { ensureDatabaseReady, pool, updateDocumentStatus } from './db';
import { signToken } from './auth';
import { env } from './env';
import { requireAuth, type AuthenticatedRequest } from './auth-middleware';
import { processDocumentAndGenerateQuestions } from './pipeline';
import { createRequestLogger } from './logger';

fs.mkdirSync(path.resolve(env.UPLOAD_DIR), { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: path.resolve(env.UPLOAD_DIR),
    filename(_req, file, cb) {
      const unique = `${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      cb(null, `${unique}${path.extname(file.originalname)}`);
    },
  }),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter(_req, file, cb) {
    if (file.mimetype !== 'application/pdf') {
      cb(new Error('仅支持 PDF'));
      return;
    }
    cb(null, true);
  },
});

const app = express();
app.use(cors());
app.use(express.json());

app.use((req, res, next) => {
  const requestId = req.headers['x-request-id']?.toString() || crypto.randomUUID();
  (req as unknown as { requestId?: string }).requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  next();
});

const authSchema = z.object({
  username: z.string().min(2).max(64),
  password: z.string().min(6).max(128),
});

const submitSchema = z.object({
  questionId: z.string().uuid(),
  answers: z
    .array(
      z.object({
        blankId: z.string().uuid(),
        userInput: z.string().min(1),
      }),
    )
    .min(1),
});

function asyncHandler(handler: (req: express.Request, res: express.Response, next: express.NextFunction) => Promise<unknown>) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function isPgUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === '23505');
}

app.post(
  '/api/v1/auth/register',
  asyncHandler(async (req, res) => {
    const parsed = authSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { username, password } = parsed.data;
    const passwordHash = await bcrypt.hash(password, 10);

    try {
      const result = await pool.query<{ id: string; username: string }>(
        `insert into users (id, username, password_hash) values (gen_random_uuid(), $1, $2) returning id, username`,
        [username, passwordHash],
      );
      const user = result.rows[0];
      const token = signToken({ sub: user.id, username: user.username });
      return res.status(201).json({ id: user.id, username: user.username, token });
    } catch (error: unknown) {
      if (isPgUniqueViolation(error)) {
        return res.status(409).json({ error: '用户名已存在' });
      }

      throw error;
    }
  }),
);

app.post(
  '/api/v1/auth/login',
  asyncHandler(async (req, res) => {
    const parsed = authSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { username, password } = parsed.data;
    const result = await pool.query<{ id: string; username: string; password_hash: string }>(
      `select id, username, password_hash from users where username = $1`,
      [username],
    );
    const user = result.rows[0];
    if (!user) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: '用户名或密码错误' });
    }

    const token = signToken({ sub: user.id, username: user.username });
    return res.json({ id: user.id, username: user.username, token });
  }),
);

function runDocumentParseJob(payload: { userId: string; documentId: string; filePath: string }) {
  processDocumentAndGenerateQuestions(payload)
    .then(async (result) => {
      await pool.query(
        `update documents set knowledge_point_count = $1, blank_slot_count = $2, question_count = $3, updated_at = now() where id = $4`,
        [result.knowledgePointCount, result.blankSlotCount, result.questionCount, payload.documentId],
      );
    })
    .catch(async (error) => {
      console.error('background document parse failed', error);
      await updateDocumentStatus(payload.documentId, 'parse_failed', error instanceof Error ? error.message : '解析失败');
    });
}

app.post(
  '/api/v1/documents/upload',
  requireAuth,
  upload.single('file'),
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const file = req.file;
    const title = (req.body?.title as string | undefined)?.trim();
    const log = createRequestLogger(req, res);
    console.log('Upload request body:', JSON.stringify(req.body));
    console.log('Upload title:', title, 'originalname:', file?.originalname);
    if (!file) {
      return res.status(400).json({ error: '请上传 PDF 文件' });
    }

    const documentResult = await pool.query<{ id: string }>(
      `insert into documents (id, user_id, title, source_filename, status) values (gen_random_uuid(), $1, $2, $3, 'uploaded') returning id`,
      [req.userId, title || file.originalname, file.originalname],
    );
    const document = documentResult.rows[0];

    await pool.query(
      `insert into document_source_files (id, document_id, storage_key, mime_type, byte_size) values (gen_random_uuid(), $1, $2, $3, $4)`,
      [document.id, file.path, file.mimetype, file.size],
    );

    await updateDocumentStatus(document.id, 'parsing');

    if (env.SYNC_PARSE) {
      try {
        const result = await processDocumentAndGenerateQuestions({
          userId: req.userId!,
          documentId: document.id,
          filePath: file.path,
        });

        log.info('document parsed synchronously', {
          documentId: document.id,
          knowledgePointCount: result.knowledgePointCount,
          blankSlotCount: result.blankSlotCount,
          questionCount: result.questionCount,
        });

        return res.status(201).json({
          documentId: document.id,
          status: 'parsed',
          knowledgePointCount: result.knowledgePointCount,
          blankSlotCount: result.blankSlotCount,
          questionCount: result.questionCount,
        });
      } catch (error) {
        log.error('document sync parse failed', { documentId: document.id });
        await updateDocumentStatus(document.id, 'parse_failed', error instanceof Error ? error.message : 'PDF 解析或真题生成失败');
        return res.status(500).json({ error: 'PDF 解析或真题生成失败' });
      }
    }

    runDocumentParseJob({
      userId: req.userId!,
      documentId: document.id,
      filePath: file.path,
    });

    log.info('document queued for background parsing', { documentId: document.id });
    return res.status(202).json({ documentId: document.id, status: 'parsing' });
  }),
);

app.get(
  '/api/v1/documents',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const result = await pool.query<{
      id: string;
      title: string;
      status: string;
      error_message: string | null;
      question_count: number;
      updated_at: string;
    }>(
      `select d.id, d.title, d.status, d.error_message,
              coalesce(d.question_count, 0)::int as question_count,
              d.updated_at::text
       from documents d
       where d.user_id = $1
       order by d.created_at desc`,
      [req.userId],
    );

    return res.json({
      documents: result.rows.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        errorMessage: row.error_message,
        questionCount: row.question_count,
        updatedAt: row.updated_at,
      })),
    });
  }),
);

app.delete(
  '/api/v1/documents/:documentId',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { documentId } = req.params;

    const document = await pool.query<{ id: string; user_id: string }>(
      `select id, user_id from documents where id = $1`,
      [documentId],
    );

    const doc = document.rows[0];
    if (!doc) {
      return res.status(404).json({ error: '文档不存在' });
    }

    if (doc.user_id !== req.userId) {
      return res.status(403).json({ error: '无权删除该文档' });
    }

    const client = await pool.connect();
    try {
      await client.query('begin');

      // Delete in dependency order
      await client.query(
        `delete from attempt_items where session_id in (
           select ps.id from practice_sessions ps
           join questions q on q.id = ps.target_id
           join knowledge_points kp on kp.id = q.knowledge_point_id
           where kp.document_id = $1
         )`,
        [documentId],
      );
      await client.query(
        `delete from user_blank_progress where blank_slot_id in (
           select bs.id from blank_slots bs
           join knowledge_points kp on kp.id = bs.knowledge_point_id
           where kp.document_id = $1
         )`,
        [documentId],
      );
      await client.query(
        `delete from practice_sessions where target_id in (
           select q.id from questions q
           join knowledge_points kp on kp.id = q.knowledge_point_id
           where kp.document_id = $1
         )`,
        [documentId],
      );
      await client.query(
        `delete from mistake_book_items where question_id in (
           select q.id from questions q
           join knowledge_points kp on kp.id = q.knowledge_point_id
           where kp.document_id = $1
         ) or blank_slot_id in (
           select bs.id from blank_slots bs
           join knowledge_points kp on kp.id = bs.knowledge_point_id
           where kp.document_id = $1
         )`,
        [documentId],
      );
      await client.query(
        `delete from question_blanks where question_id in (
           select q.id from questions q
           join knowledge_points kp on kp.id = q.knowledge_point_id
           where kp.document_id = $1
         )`,
        [documentId],
      );
      await client.query(
        `delete from questions where knowledge_point_id in (
           select id from knowledge_points where document_id = $1
         )`,
        [documentId],
      );
      await client.query(
        `delete from blank_slots where knowledge_point_id in (
           select id from knowledge_points where document_id = $1
         )`,
        [documentId],
      );
      await client.query(`delete from knowledge_points where document_id = $1`, [documentId]);
      await client.query(`delete from document_tags where document_id = $1`, [documentId]);
      await client.query(`delete from document_source_files where document_id = $1`, [documentId]);
      await client.query(`delete from documents where id = $1`, [documentId]);

      await client.query('commit');
      return res.json({ success: true });
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }),
);

app.get(
  '/api/v1/documents/:documentId/status',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { documentId } = req.params;

    const document = await pool.query<{
      id: string;
      user_id: string;
      title: string;
      status: string;
      error_message: string | null;
      updated_at: string;
    }>(
      `select id, user_id, title, status, error_message, updated_at::text from documents where id = $1`,
      [documentId],
    );

    const doc = document.rows[0];
    if (!doc) {
      return res.status(404).json({ error: '文档不存在' });
    }

    if (doc.user_id !== req.userId) {
      return res.status(403).json({ error: '无权访问该文档' });
    }

    const responseBody: Record<string, unknown> = {
      documentId: doc.id,
      title: doc.title,
      status: doc.status,
      updatedAt: doc.updated_at,
    };

    if (doc.error_message) {
      responseBody.errorMessage = doc.error_message;
    }

    return res.json(responseBody);
  }),
);

app.post(
  '/api/v1/documents/:documentId/reparse',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { documentId } = req.params;

    const document = await pool.query<{
      id: string;
      user_id: string;
      status: string;
      source_filename: string;
    }>(
      `select id, user_id, status, source_filename from documents where id = $1`,
      [documentId],
    );

    const doc = document.rows[0];
    if (!doc) {
      return res.status(404).json({ error: '文档不存在' });
    }

    if (doc.user_id !== req.userId) {
      return res.status(403).json({ error: '无权操作该文档' });
    }

    if (doc.status === 'parsing' || doc.status === 'queued') {
      return res.status(409).json({ error: '文档正在解析中，请稍后重试' });
    }

    const sourceFile = await pool.query<{ storage_key: string }>(
      `select storage_key from document_source_files where document_id = $1 order by created_at desc limit 1`,
      [documentId],
    );

    const storageKey = sourceFile.rows[0]?.storage_key;
    if (!storageKey) {
      return res.status(409).json({ error: '未找到可重试的源文件记录' });
    }

    await updateDocumentStatus(documentId, 'parsing');

    if (env.SYNC_PARSE) {
      try {
        const result = await processDocumentAndGenerateQuestions({
          userId: req.userId!,
          documentId,
          filePath: storageKey,
        });

        return res.status(200).json({
          documentId,
          status: 'parsed',
          knowledgePointCount: result.knowledgePointCount,
          blankSlotCount: result.blankSlotCount,
          questionCount: result.questionCount,
        });
      } catch (error) {
        await updateDocumentStatus(documentId, 'parse_failed', error instanceof Error ? error.message : 'PDF 解析或真题生成失败');
        return res.status(500).json({ error: 'PDF 解析或真题生成失败' });
      }
    }

    runDocumentParseJob({
      userId: req.userId!,
      documentId,
      filePath: storageKey,
    });

    return res.status(202).json({ documentId, status: 'parsing' });
  }),
);

app.get(
  '/api/v1/documents/:documentId/questions',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { documentId } = req.params;
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Math.min(100, Math.max(1, Number(req.query.pageSize) || 20));
    const offset = (page - 1) * pageSize;

    const document = await pool.query<{ id: string; user_id: string; title: string; status: string }>(
      `select id, user_id, title, status from documents where id = $1`,
      [documentId],
    );

    const doc = document.rows[0];
    if (!doc) {
      return res.status(404).json({ error: '文档不存在' });
    }

    if (doc.user_id !== req.userId) {
      return res.status(403).json({ error: '无权访问该文档' });
    }

    if (doc.status !== 'parsed') {
      const statusMessage =
        doc.status === 'parsing' || doc.status === 'queued'
          ? '文档正在解析中，请稍后重试'
          : '文档尚未完成解析';
      return res.status(409).json({ error: statusMessage });
    }

    const totalResult = await pool.query<{ total: number }>(
      `select count(*)::int as total
       from questions q
       join knowledge_points kp on kp.id = q.knowledge_point_id
       where kp.document_id = $1 and q.status = 'active'`,
      [documentId],
    );
    const total = totalResult.rows[0]?.total ?? 0;

    const pagedQuestionIds = await pool.query<{ id: string }>(
      `select q.id
       from questions q
       join knowledge_points kp on kp.id = q.knowledge_point_id
       where kp.document_id = $1 and q.status = 'active'
       order by q.created_at asc
       limit $2 offset $3`,
      [documentId, pageSize, offset],
    );

    const questionIds = pagedQuestionIds.rows.map((row) => row.id);

    if (questionIds.length === 0) {
      return res.json({
        documentId: doc.id,
        title: doc.title,
        pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
        questions: [],
      });
    }

    const questions = await pool.query<{
      question_id: string;
      stem_html: string;
      stem_text: string;
      blank_id: string;
      answer_text: string;
      color_type: string;
    }>(
      `select q.id as question_id,
              q.stem_html,
              q.stem_text,
              qb.blank_slot_id as blank_id,
              qb.answer_text,
              bs.color_type
       from questions q
       join question_blanks qb on qb.question_id = q.id
       join blank_slots bs on bs.id = qb.blank_slot_id
       where q.id = ANY($1::uuid[])
       order by q.created_at asc, qb.position_index asc`,
      [questionIds],
    );

    const grouped = new Map<
      string,
      {
        questionId: string;
        stemHtml: string;
        stemText: string;
        blanks: { blankId: string; colorType: string; answerText: string }[];
      }
    >();

    for (const row of questions.rows) {
      let entry = grouped.get(row.question_id);
      if (!entry) {
        entry = {
          questionId: row.question_id,
          stemHtml: row.stem_html,
          stemText: row.stem_text,
          blanks: [],
        };
        grouped.set(row.question_id, entry);
      }

      entry.blanks.push({ blankId: row.blank_id, colorType: row.color_type, answerText: row.answer_text });
    }

    return res.json({
      documentId: doc.id,
      title: doc.title,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
      questions: Array.from(grouped.values()),
    });
  }),
);

app.post(
  '/api/v1/practice/submit',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const parsed = submitSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const { questionId, answers } = parsed.data;

    const questionRow = await pool.query<{ id: string; knowledge_point_id: string }>(
      `select id, knowledge_point_id from questions where id = $1 and status = 'active'`,
      [questionId],
    );
    const question = questionRow.rows[0];
    if (!question) {
      return res.status(404).json({ error: '题目不存在' });
    }

    const blankIds = answers.map((a) => a.blankId);
    const blanks = await pool.query<{ id: string; question_id: string; blank_slot_id: string; answer_text: string }>(
      `select id, question_id, blank_slot_id, answer_text from question_blanks where question_id = $1 and blank_slot_id = ANY($2::uuid[])`,
      [questionId, blankIds],
    );

    const blanksBySlot = new Map(blanks.rows.map((b) => [b.blank_slot_id, b]));
    const results: { blankId: string; correct: boolean; matchedRule: string; answerText: string }[] = [];
    let correctCount = 0;

    const client = await pool.connect();
    try {
      await client.query('begin');

      const sessionRes = await client.query<{ id: string }>(
        `insert into practice_sessions (id, user_id, target_type, target_id, mode, status, total_count, correct_count)
         values (gen_random_uuid(), $1, 'question', $2, 'single', 'completed', $3, $4)
         returning id`,
        [req.userId, questionId, answers.length, 0],
      );
      const sessionId = sessionRes.rows[0].id;

      for (const answer of answers) {
        const blank = blanksBySlot.get(answer.blankId);
        if (!blank) {
          continue;
        }

        const normalizedInput = answer.userInput.trim().replace(/\s+/g, '');
        const normalizedAnswer = blank.answer_text.trim().replace(/\s+/g, '');
        const isCorrect = normalizedInput === normalizedAnswer;
        const matchedRule = isCorrect ? 'exact_match' : 'mismatch';
        if (isCorrect) {
          correctCount += 1;
        }

        await client.query(
          `insert into attempt_items (id, session_id, question_id, question_blank_id, user_input, is_correct, matched_rule)
           values (gen_random_uuid(), $1, $2, $3, $4, $5, $6)`,
          [sessionId, questionId, blank.id, answer.userInput, isCorrect, matchedRule],
        );

        await client.query(
          `insert into user_blank_progress (id, user_id, blank_slot_id, correct_times, wrong_times, last_practiced_at, next_review_at, mastery_level)
           values (gen_random_uuid(), $1, $2, $3, $4, now(), now(), 0)
           on conflict (user_id, blank_slot_id)
           do update set
             correct_times = user_blank_progress.correct_times + $3,
             wrong_times = user_blank_progress.wrong_times + $4,
             last_practiced_at = now(),
             next_review_at = now()`,
          [req.userId, blank.blank_slot_id, isCorrect ? 1 : 0, isCorrect ? 0 : 1],
        );

        results.push({ blankId: answer.blankId, correct: isCorrect, matchedRule, answerText: blank.answer_text });
      }

      await client.query(
        `update practice_sessions set correct_count = $1 where id = $2`,
        [correctCount, sessionId],
      );

      await client.query('commit');
      return res.json({ sessionId, total: answers.length, correctCount, results });
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }),
);

app.get(
  '/api/v1/stats',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const userId = req.userId;

    const [documents, parsedDocs, questions, blanks, progress, recentSessions] = await Promise.all([
      pool.query<{ total: number }>(`select count(*)::int as total from documents where user_id = $1`, [userId]),
      pool.query<{ total: number }>(
        `select count(*)::int as total from documents where user_id = $1 and status = 'parsed'`,
        [userId],
      ),
      pool.query<{ total: number }>(
        `select count(*)::int as total from questions q
         join knowledge_points kp on kp.id = q.knowledge_point_id
         where kp.user_id = $1 and q.status = 'active'`,
        [userId],
      ),
      pool.query<{ total: number }>(
        `select count(*)::int as total from blank_slots bs
         join knowledge_points kp on kp.id = bs.knowledge_point_id
         where kp.user_id = $1`,
        [userId],
      ),
      pool.query<{ correct_times: number; wrong_times: number }>(
        `select coalesce(sum(correct_times), 0)::int as correct_times,
                coalesce(sum(wrong_times), 0)::int as wrong_times
         from user_blank_progress
         where user_id = $1`,
        [userId],
      ),
      pool.query<{ id: string; total_count: number; correct_count: number; started_at: string }>(
        `select id, total_count, correct_count, started_at::text
         from practice_sessions
         where user_id = $1
         order by started_at desc
         limit 5`,
        [userId],
      ),
    ]);

    const totalAttempts = progress.rows[0].correct_times + progress.rows[0].wrong_times;
    const accuracy = totalAttempts === 0 ? 0 : Math.round((progress.rows[0].correct_times / totalAttempts) * 100);

    return res.json({
      documentCount: documents.rows[0].total,
      parsedDocumentCount: parsedDocs.rows[0].total,
      questionCount: questions.rows[0].total,
      blankCount: blanks.rows[0].total,
      totalAttempts,
      accuracy,
      correctTimes: progress.rows[0].correct_times,
      wrongTimes: progress.rows[0].wrong_times,
      recentSessions: recentSessions.rows,
    });
  }),
);

app.get(
  '/api/v1/health',
  asyncHandler(async (_req, res) => {
    const [dbCheck, docStats, questionStats] = await Promise.all([
      pool.query<{ now: string }>('select now()::text as now'),
      pool.query<{ total: number; parsed: number; parse_failed: number }>(
        `select
           count(*)::int as total,
           count(*) filter (where status = 'parsed')::int as parsed,
           count(*) filter (where status = 'parse_failed')::int as parse_failed
         from documents`,
      ),
      pool.query<{ question_count: number }>(`select count(*)::int as question_count from questions`),
    ]);

    res.json({
      status: 'ok',
      db: dbCheck.rows[0].now,
      documents: docStats.rows[0],
      questionCount: questionStats.rows[0].question_count,
    });
  }),
);


/* ------------------------------------------------------------------ */
/*  Knowledge Points CRUD                                              */
/* ------------------------------------------------------------------ */

const knowledgePointUpdateSchema = z.object({
  sectionTitle: z.string().max(512).optional(),
  contentText: z.string().min(1).max(5000).optional(),
  contentHtml: z.string().max(10000).optional(),
  isHighlight: z.boolean().optional(),
});

// GET /api/v1/documents/:documentId/knowledge-points — list all knowledge points for a document
app.get(
  '/api/v1/documents/:documentId/knowledge-points',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { documentId } = req.params;

    const document = await pool.query<{ id: string; user_id: string }>(
      `select id, user_id from documents where id = $1`,
      [documentId],
    );

    if (!document.rows[0]) return res.status(404).json({ error: '文档不存在' });
    if (document.rows[0].user_id !== req.userId) return res.status(403).json({ error: '无权访问' });

    const result = await pool.query<{
      id: string;
      section_title: string | null;
      content_text: string;
      content_html: string | null;
      page_from: number | null;
      page_to: number | null;
      order_index: number;
      is_highlight: boolean;
      blank_count: number;
    }>(
      `select kp.id, kp.section_title, kp.content_text, kp.content_html,
              kp.page_from, kp.page_to, kp.order_index,
              coalesce((kp.meta->>'isHighlight')::boolean, false) as is_highlight,
              (select count(*)::int from blank_slots bs where bs.knowledge_point_id = kp.id) as blank_count
       from knowledge_points kp
       where kp.document_id = $1
       order by kp.order_index asc`,
      [documentId],
    );

    return res.json({
      documentId,
      knowledgePoints: result.rows.map((row) => ({
        id: row.id,
        sectionTitle: row.section_title,
        contentText: row.content_text,
        contentHtml: row.content_html,
        pageFrom: row.page_from,
        pageTo: row.page_to,
        orderIndex: row.order_index,
        isHighlight: row.is_highlight,
        blankCount: row.blank_count,
      })),
    });
  }),
);

// PATCH /api/v1/knowledge-points/:knowledgePointId — update content or highlight status
app.patch(
  '/api/v1/knowledge-points/:knowledgePointId',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { knowledgePointId } = req.params;
    const parsed = knowledgePointUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.flatten() });
    }

    const kp = await pool.query<{ id: string; user_id: string; document_id: string; meta: Record<string, unknown> | null }>(
      `select id, user_id, document_id, meta from knowledge_points where id = $1`,
      [knowledgePointId],
    );

    if (!kp.rows[0]) return res.status(404).json({ error: '知识点不存在' });
    if (kp.rows[0].user_id !== req.userId) return res.status(403).json({ error: '无权操作' });

    const updates: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    if (parsed.data.sectionTitle !== undefined) {
      updates.push(`section_title = $${paramIndex++}`);
      values.push(parsed.data.sectionTitle);
    }
    if (parsed.data.contentText !== undefined) {
      updates.push(`content_text = $${paramIndex++}`);
      values.push(parsed.data.contentText);
    }
    if (parsed.data.contentHtml !== undefined) {
      updates.push(`content_html = $${paramIndex++}`);
      values.push(parsed.data.contentHtml);
    }
    if (parsed.data.isHighlight !== undefined) {
      const existingMeta = kp.rows[0].meta ?? {};
      const newMeta = { ...existingMeta, isHighlight: parsed.data.isHighlight };
      updates.push(`meta = $${paramIndex++}::jsonb`);
      values.push(JSON.stringify(newMeta));
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: '没有需要更新的字段' });
    }

    values.push(knowledgePointId);
    await pool.query(
      `update knowledge_points set ${updates.join(', ')} where id = $${paramIndex}`,
      values,
    );

    return res.json({ success: true });
  }),
);

// DELETE /api/v1/knowledge-points/:knowledgePointId — delete a knowledge point and its related data
app.delete(
  '/api/v1/knowledge-points/:knowledgePointId',
  requireAuth,
  asyncHandler(async (req: AuthenticatedRequest, res) => {
    const { knowledgePointId } = req.params;

    const kp = await pool.query<{ id: string; user_id: string; document_id: string }>(
      `select id, user_id, document_id from knowledge_points where id = $1`,
      [knowledgePointId],
    );

    if (!kp.rows[0]) return res.status(404).json({ error: '知识点不存在' });
    if (kp.rows[0].user_id !== req.userId) return res.status(403).json({ error: '无权操作' });

    const client = await pool.connect();
    try {
      await client.query('begin');

      // Delete in dependency order
      await client.query(
        `delete from attempt_items where session_id in (
           select ps.id from practice_sessions ps
           join questions q on q.id = ps.target_id
           where q.knowledge_point_id = $1
         )`,
        [knowledgePointId],
      );
      await client.query(
        `delete from user_blank_progress where blank_slot_id in (
           select id from blank_slots where knowledge_point_id = $1
         )`,
        [knowledgePointId],
      );
      await client.query(
        `delete from mistake_book_items where question_id in (
           select id from questions where knowledge_point_id = $1
         ) or blank_slot_id in (
           select id from blank_slots where knowledge_point_id = $1
         )`,
        [knowledgePointId],
      );
      await client.query(
        `delete from question_blanks where question_id in (
           select id from questions where knowledge_point_id = $1
         )`,
        [knowledgePointId],
      );
      await client.query(`delete from questions where knowledge_point_id = $1`, [knowledgePointId]);
      await client.query(`delete from blank_slots where knowledge_point_id = $1`, [knowledgePointId]);
      await client.query(`delete from knowledge_points where id = $1`, [knowledgePointId]);

      // Update document question count
      const docId = kp.rows[0].document_id;
      const counts = await client.query<{ kp_count: number; blank_count: number; q_count: number }>(
        `select
           (select count(*)::int from knowledge_points where document_id = $1) as kp_count,
           (select count(*)::int from blank_slots bs join knowledge_points kp on kp.id = bs.knowledge_point_id where kp.document_id = $1) as blank_count,
           (select count(*)::int from questions q join knowledge_points kp on kp.id = q.knowledge_point_id where kp.document_id = $1 and q.status = 'active') as q_count`,
        [docId],
      );
      await client.query(
        `update documents set knowledge_point_count = $1, blank_slot_count = $2, question_count = $3, updated_at = now() where id = $4`,
        [counts.rows[0].kp_count, counts.rows[0].blank_count, counts.rows[0].q_count, docId],
      );

      await client.query('commit');
      return res.json({ success: true });
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }),
);

app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const requestId = (req as unknown as { requestId?: string }).requestId;

  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message, requestId });
  }

  if (err instanceof Error && err.message) {
    console.error('unhandled route error', { requestId, message: err.message, stack: err.stack });
    return res.status(500).json({ error: '系统异常', requestId });
  }

  console.error('unhandled route error', { requestId, error: err });
  return res.status(500).json({ error: '系统异常', requestId });
});

ensureDatabaseReady()
  .then(() => {
    app.listen(env.APP_PORT, () => {
      const log = {
        level: 'info',
        message: 'free-memory server started',
        port: env.APP_PORT,
        apiBase: `http://localhost:${env.APP_PORT}/api/v1`,
      };
      process.stdout.write(JSON.stringify(log) + '\n');
    });
  })
  .catch((error) => {
    console.error('Failed to start server because database readiness check failed', error);
    process.exit(1);
  });

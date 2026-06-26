import fs from 'node:fs';
import path from 'node:path';
import cors from 'cors';
import express from 'express';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { pool } from './db';
import { signToken } from './auth';
import { env } from './env';
import { requireAuth, type AuthenticatedRequest } from './auth-middleware';
import { processDocumentAndGenerateQuestions } from './pipeline';

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

const authSchema = z.object({
  username: z.string().min(2).max(64),
  password: z.string().min(6).max(128),
});

const submitSchema = z.object({
  questionId: z.string().uuid(),
  answers: z.array(
    z.object({
      blankId: z.string().uuid(),
      userInput: z.string().min(1),
    })
  ).min(1),
});

app.post('/api/v1/auth/register', async (req, res) => {
  const parsed = authSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { username, password } = parsed.data;
  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const result = await pool.query<{ id: string; username: string }>(
      `insert into users (id, username, password_hash) values (gen_random_uuid(), $1, $2) returning id, username`,
      [username, passwordHash]
    );
    const user = result.rows[0];
    const token = signToken({ sub: user.id, username: user.username });
    return res.status(201).json({ id: user.id, username: user.username, token });
  } catch (error: unknown) {
    if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === '23505') {
      return res.status(409).json({ error: '用户名已存在' });
    }
    return res.status(500).json({ error: '注册失败' });
  }
});

app.post('/api/v1/auth/login', async (req, res) => {
  const parsed = authSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { username, password } = parsed.data;
  const result = await pool.query<{ id: string; username: string; password_hash: string }>(
    `select id, username, password_hash from users where username = $1`,
    [username]
  );
  const user = result.rows[0];
  if (!user) return res.status(401).json({ error: '用户名或密码错误' });

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: '用户名或密码错误' });

  const token = signToken({ sub: user.id, username: user.username });
  return res.json({ id: user.id, username: user.username, token });
});

app.post('/api/v1/documents/upload', requireAuth, upload.single('file'), async (req: AuthenticatedRequest, res) => {
  const file = req.file;
  const title = (req.body?.title as string | undefined)?.trim();
  if (!file) return res.status(400).json({ error: '请上传 PDF 文件' });

  const documentResult = await pool.query<{ id: string }>(
    `insert into documents (id, user_id, title, source_filename, status) values (gen_random_uuid(), $1, $2, $3, 'uploaded') returning id`,
    [req.userId, title || file.originalname, file.originalname]
  );
  const document = documentResult.rows[0];

  await pool.query(
    `insert into document_source_files (id, document_id, storage_key, mime_type, byte_size) values (gen_random_uuid(), $1, $2, $3, $4)`,
    [document.id, file.path, file.mimetype, file.size]
  );

  try {
    const result = await processDocumentAndGenerateQuestions({
      userId: req.userId!,
      documentId: document.id,
      filePath: file.path,
    });

    return res.status(201).json({
      documentId: document.id,
      status: 'parsed',
      knowledgePointCount: result.knowledgePointCount,
      blankSlotCount: result.blankSlotCount,
      questionCount: result.questionCount,
    });
  } catch (error) {
    console.error('parse pdf failed', error);
    await pool.query(`update documents set status = 'parse_failed', updated_at = now() where id = $1`, [document.id]);
    return res.status(500).json({ error: 'PDF 解析或真题生成失败' });
  }
});

app.get('/api/v1/documents/:documentId/questions', requireAuth, async (req: AuthenticatedRequest, res) => {
  const documentId = req.params.documentId;

  const document = await pool.query<{ id: string; user_id: string; title: string; status: string }>(
    `select id, user_id, title, status from documents where id = $1`,
    [documentId]
  );

  const doc = document.rows[0];
  if (!doc) return res.status(404).json({ error: '文档不存在' });
  if (doc.user_id !== req.userId) return res.status(403).json({ error: '无权访问该文档' });
  if (doc.status !== 'parsed') return res.status(409).json({ error: '文档尚未完成解析' });

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
     join knowledge_points kp on kp.id = q.knowledge_point_id
     where kp.document_id = $1 and q.status = 'active'
     order by q.created_at, qb.position_index`,
    [documentId]
  );

  const grouped = new Map<string, {
    questionId: string;
    stemHtml: string;
    stemText: string;
    blanks: { blankId: string; colorType: string; answerText: string }[];
  }>();

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
    questions: Array.from(grouped.values()),
  });
});

app.post('/api/v1/practice/submit', requireAuth, async (req: AuthenticatedRequest, res) => {
  const parsed = submitSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { questionId, answers } = parsed.data;

  const questionRow = await pool.query<{ id: string; knowledge_point_id: string }>(
    `select id, knowledge_point_id from questions where id = $1 and status = 'active'`,
    [questionId]
  );
  const question = questionRow.rows[0];
  if (!question) return res.status(404).json({ error: '题目不存在' });

  const blankIds = answers.map((a) => a.blankId);
  const blanks = await pool.query<{ id: string; question_id: string; blank_slot_id: string; answer_text: string }>(
    `select id, question_id, blank_slot_id, answer_text from question_blanks where question_id = $1 and blank_slot_id = ANY($2::uuid[])`,
    [questionId, blankIds]
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
      [req.userId, questionId, answers.length, 0]
    );
    const sessionId = sessionRes.rows[0].id;

    for (const answer of answers) {
      const blank = blanksBySlot.get(answer.blankId);
      if (!blank) continue;

      const normalizedInput = answer.userInput.trim().replace(/\s+/g, '');
      const normalizedAnswer = blank.answer_text.trim().replace(/\s+/g, '');
      const isCorrect = normalizedInput === normalizedAnswer;
      const matchedRule = isCorrect ? 'exact_match' : 'mismatch';
      if (isCorrect) correctCount += 1;

      await client.query(
        `insert into attempt_items (id, session_id, question_id, question_blank_id, user_input, is_correct, matched_rule)
         values (gen_random_uuid(), $1, $2, $3, $4, $5, $6)`,
        [sessionId, questionId, blank.id, answer.userInput, isCorrect, matchedRule]
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
        [req.userId, blank.blank_slot_id, isCorrect ? 1 : 0, isCorrect ? 0 : 1]
      );

      results.push({ blankId: answer.blankId, correct: isCorrect, matchedRule, answerText: blank.answer_text });
    }

    await client.query(
      `update practice_sessions set correct_count = $1 where id = $2`,
      [correctCount, sessionId]
    );

    await client.query('commit');
    return res.json({ sessionId, total: answers.length, correctCount, results });
  } catch (error) {
    await client.query('rollback');
    console.error('submit practice failed', error);
    return res.status(500).json({ error: '提交作答失败' });
  } finally {
    client.release();
  }
});

app.get('/api/v1/stats', requireAuth, async (req: AuthenticatedRequest, res) => {
  const userId = req.userId;

  const [documents, parsedDocs, questions, blanks, progress, recentSessions] = await Promise.all([
    pool.query<{ total: number }>(
      `select count(*)::int as total from documents where user_id = $1`,
      [userId]
    ),
    pool.query<{ total: number }>(
      `select count(*)::int as total from documents where user_id = $1 and status = 'parsed'`,
      [userId]
    ),
    pool.query<{ total: number }>(
      `select count(*)::int as total from questions q
       join knowledge_points kp on kp.id = q.knowledge_point_id
       where kp.user_id = $1 and q.status = 'active'`,
      [userId]
    ),
    pool.query<{ total: number }>(
      `select count(*)::int as total from blank_slots bs
       join knowledge_points kp on kp.id = bs.knowledge_point_id
       where kp.user_id = $1`,
      [userId]
    ),
    pool.query<{ correct_times: number; wrong_times: number }>(
      `select coalesce(sum(correct_times), 0)::int as correct_times,
              coalesce(sum(wrong_times), 0)::int as wrong_times
       from user_blank_progress
       where user_id = $1`,
      [userId]
    ),
    pool.query<{ id: string; total_count: number; correct_count: number; started_at: string }>(
      `select id, total_count, correct_count, started_at::text
       from practice_sessions
       where user_id = $1
       order by started_at desc
       limit 5`,
      [userId]
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
});

app.get('/api/v1/health', async (_req, res) => {
  const [dbCheck, docStats, questionStats] = await Promise.all([
    pool.query<{ now: string }>('select now()::text as now'),
    pool.query<{ total: number; parsed: number; parse_failed: number }>(
      `select
         count(*)::int as total,
         count(*) filter (where status = 'parsed')::int as parsed,
         count(*) filter (where status = 'parse_failed')::int as parse_failed
       from documents`
    ),
    pool.query<{ question_count: number }>(
      `select count(*)::int as question_count from questions`
    ),
  ]);

  res.json({
    status: 'ok',
    db: dbCheck.rows[0].now,
    documents: docStats.rows[0],
    questionCount: questionStats.rows[0].question_count,
  });
});

app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: err.message });
  }
  if (err instanceof Error) {
    return res.status(400).json({ error: err.message });
  }
  return res.status(500).json({ error: '系统异常' });
});


app.listen(env.APP_PORT, () => {
  console.log(`free-memory server listening on http://localhost:${env.APP_PORT}`);
  console.log(`api base: http://localhost:${env.APP_PORT}/api/v1`);
});

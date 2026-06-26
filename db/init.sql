-- FreeMemory 数据库初始化脚本
-- 1) 先在 PostgreSQL 中创建目标数据库与用户（使用超级账号执行）。
-- 2) 再对 FreeMemory 库执行本 SQL 创建表结构。

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- users
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(64) NOT NULL UNIQUE,
  password_hash VARCHAR(256) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

-- documents
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  title VARCHAR(256) NOT NULL,
  source_filename VARCHAR(512) NOT NULL,
  page_count INT,
  status VARCHAR(32) NOT NULL DEFAULT 'uploaded',
  meta JSONB,
  created_at TIMESTAMP NOT NULL DEFAULT now(),
  updated_at TIMESTAMP NOT NULL DEFAULT now()
);

-- document_source_files
CREATE TABLE IF NOT EXISTS document_source_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id),
  storage_key VARCHAR(1024) NOT NULL,
  mime_type VARCHAR(128) NOT NULL,
  byte_size BIGINT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- knowledge_points
CREATE TABLE IF NOT EXISTS knowledge_points (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id UUID NOT NULL REFERENCES documents(id),
  user_id UUID NOT NULL REFERENCES users(id),
  page_from INT,
  page_to INT,
  section_title VARCHAR(512),
  content_text TEXT NOT NULL,
  content_html TEXT,
  order_index INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- blank_slots
CREATE TABLE IF NOT EXISTS blank_slots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_point_id UUID NOT NULL REFERENCES knowledge_points(id),
  original_text TEXT NOT NULL,
  normalized_answer TEXT NOT NULL,
  color_type VARCHAR(16) NOT NULL,
  char_start INT,
  char_end INT,
  order_index INT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- questions
CREATE TABLE IF NOT EXISTS questions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_point_id UUID NOT NULL REFERENCES knowledge_points(id),
  stem_html TEXT NOT NULL,
  stem_text TEXT NOT NULL,
  difficulty INT NOT NULL DEFAULT 1,
  status VARCHAR(32) NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- question_blanks
CREATE TABLE IF NOT EXISTS question_blanks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question_id UUID NOT NULL REFERENCES questions(id),
  blank_slot_id UUID NOT NULL REFERENCES blank_slots(id),
  position_index INT NOT NULL,
  answer_text TEXT NOT NULL,
  answer_variants TEXT[],
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- practice_sessions
CREATE TABLE IF NOT EXISTS practice_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  target_type VARCHAR(32) NOT NULL,
  target_id UUID NOT NULL,
  mode VARCHAR(32) NOT NULL DEFAULT 'sequential',
  status VARCHAR(32) NOT NULL DEFAULT 'in_progress',
  total_count INT NOT NULL DEFAULT 0,
  correct_count INT NOT NULL DEFAULT 0,
  started_at TIMESTAMP NOT NULL DEFAULT now(),
  finished_at TIMESTAMP
);

-- attempt_items
CREATE TABLE IF NOT EXISTS attempt_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES practice_sessions(id),
  question_id UUID NOT NULL REFERENCES questions(id),
  question_blank_id UUID NOT NULL REFERENCES question_blanks(id),
  user_input TEXT,
  is_correct BOOLEAN NOT NULL,
  matched_rule VARCHAR(64),
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- user_blank_progress
CREATE TABLE IF NOT EXISTS user_blank_progress (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  blank_slot_id UUID NOT NULL REFERENCES blank_slots(id),
  correct_times INT NOT NULL DEFAULT 0,
  wrong_times INT NOT NULL DEFAULT 0,
  last_practiced_at TIMESTAMP,
  next_review_at TIMESTAMP,
  mastery_level INT NOT NULL DEFAULT 0,
  UNIQUE(user_id, blank_slot_id)
);

-- mistake_books
CREATE TABLE IF NOT EXISTS mistake_books (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  name VARCHAR(256) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- mistake_book_items
CREATE TABLE IF NOT EXISTS mistake_book_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  book_id UUID NOT NULL REFERENCES mistake_books(id),
  user_id UUID NOT NULL REFERENCES users(id),
  question_id UUID NOT NULL REFERENCES questions(id),
  blank_slot_id UUID NOT NULL REFERENCES blank_slots(id),
  added_from_session_id UUID,
  reason VARCHAR(256),
  created_at TIMESTAMP NOT NULL DEFAULT now()
);

-- tags
CREATE TABLE IF NOT EXISTS tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id),
  name VARCHAR(128) NOT NULL
);

-- document_tags
CREATE TABLE IF NOT EXISTS document_tags (
  document_id UUID NOT NULL REFERENCES documents(id),
  tag_id UUID NOT NULL REFERENCES tags(id),
  PRIMARY KEY (document_id, tag_id)
);

CREATE INDEX IF NOT EXISTS idx_documents_user ON documents(user_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_points_doc ON knowledge_points(document_id);
CREATE INDEX IF NOT EXISTS idx_blank_slots_knowledge ON blank_slots(knowledge_point_id);
CREATE INDEX IF NOT EXISTS idx_questions_knowledge ON questions(knowledge_point_id);
CREATE INDEX IF NOT EXISTS idx_question_blanks_question ON question_blanks(question_id);
CREATE INDEX IF NOT EXISTS idx_practice_sessions_user ON practice_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_attempt_items_session ON attempt_items(session_id);
CREATE INDEX IF NOT EXISTS idx_user_blank_progress_user ON user_blank_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_mistake_books_user ON mistake_books(user_id);
CREATE INDEX IF NOT EXISTS idx_mistake_book_items_user ON mistake_book_items(user_id);


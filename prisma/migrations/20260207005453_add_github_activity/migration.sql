-- CreateTable
CREATE TABLE "github_repository" (
    "id" TEXT NOT NULL,
    "github_id" INTEGER NOT NULL,
    "owner" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "language" TEXT,
    "stars" INTEGER NOT NULL DEFAULT 0,
    "forks" INTEGER NOT NULL DEFAULT 0,
    "is_fork" BOOLEAN NOT NULL DEFAULT false,
    "is_archived" BOOLEAN NOT NULL DEFAULT false,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "discovered_via" TEXT[],
    "last_activity_at" TIMESTAMP(3),
    "sync_tier" TEXT NOT NULL DEFAULT 'active',
    "repo_created_at" TIMESTAMP(3) NOT NULL,
    "last_synced_at" TIMESTAMP(3),
    "backfilled_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_repository_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_recent" (
    "id" TEXT NOT NULL,
    "repo_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "title" TEXT,
    "author_login" TEXT,
    "additions" INTEGER DEFAULT 0,
    "deletions" INTEGER DEFAULT 0,
    "event_date" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_recent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_historical" (
    "id" TEXT NOT NULL,
    "repo_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "commit_count" INTEGER NOT NULL DEFAULT 0,
    "pr_opened" INTEGER NOT NULL DEFAULT 0,
    "pr_merged" INTEGER NOT NULL DEFAULT 0,
    "pr_closed" INTEGER NOT NULL DEFAULT 0,
    "issues_opened" INTEGER NOT NULL DEFAULT 0,
    "issues_closed" INTEGER NOT NULL DEFAULT 0,
    "additions" INTEGER NOT NULL DEFAULT 0,
    "deletions" INTEGER NOT NULL DEFAULT 0,
    "unique_contributors" INTEGER NOT NULL DEFAULT 0,
    "avg_pr_merge_hours" DOUBLE PRECISION,
    "releases_published" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_historical_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "repo_daily_snapshot" (
    "id" TEXT NOT NULL,
    "repo_id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "stars" INTEGER NOT NULL DEFAULT 0,
    "forks" INTEGER NOT NULL DEFAULT 0,
    "open_issues" INTEGER NOT NULL DEFAULT 0,
    "watchers" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "repo_daily_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_developer" (
    "id" TEXT NOT NULL,
    "avatar_url" TEXT,
    "first_seen_at" TIMESTAMP(3) NOT NULL,
    "last_seen_at" TIMESTAMP(3) NOT NULL,
    "total_commits" INTEGER NOT NULL DEFAULT 0,
    "total_prs" INTEGER NOT NULL DEFAULT 0,
    "repo_count" INTEGER NOT NULL DEFAULT 0,
    "org_count" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "github_developer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_repository_github_id_key" ON "github_repository"("github_id");

-- CreateIndex
CREATE INDEX "activity_recent_event_date_idx" ON "activity_recent"("event_date");

-- CreateIndex
CREATE INDEX "activity_recent_repo_id_event_date_idx" ON "activity_recent"("repo_id", "event_date");

-- CreateIndex
CREATE UNIQUE INDEX "activity_recent_repo_id_event_type_event_id_key" ON "activity_recent"("repo_id", "event_type", "event_id");

-- CreateIndex
CREATE INDEX "activity_historical_date_idx" ON "activity_historical"("date");

-- CreateIndex
CREATE INDEX "activity_historical_repo_id_date_idx" ON "activity_historical"("repo_id", "date");

-- CreateIndex
CREATE UNIQUE INDEX "activity_historical_repo_id_date_key" ON "activity_historical"("repo_id", "date");

-- CreateIndex
CREATE INDEX "repo_daily_snapshot_date_idx" ON "repo_daily_snapshot"("date");

-- CreateIndex
CREATE UNIQUE INDEX "repo_daily_snapshot_repo_id_date_key" ON "repo_daily_snapshot"("repo_id", "date");

-- CreateIndex
CREATE INDEX "github_developer_last_seen_at_idx" ON "github_developer"("last_seen_at");

-- CreateIndex
CREATE INDEX "github_developer_is_active_idx" ON "github_developer"("is_active");

-- AddForeignKey
ALTER TABLE "activity_recent" ADD CONSTRAINT "activity_recent_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "github_repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_historical" ADD CONSTRAINT "activity_historical_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "github_repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "repo_daily_snapshot" ADD CONSTRAINT "repo_daily_snapshot_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "github_repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

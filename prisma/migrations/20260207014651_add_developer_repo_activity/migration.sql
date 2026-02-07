-- CreateTable
CREATE TABLE "developer_repo_activity" (
    "id" TEXT NOT NULL,
    "developer_login" TEXT NOT NULL,
    "repo_id" TEXT NOT NULL,
    "total_commits" INTEGER NOT NULL DEFAULT 0,
    "total_prs" INTEGER NOT NULL DEFAULT 0,
    "last_active_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "developer_repo_activity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "developer_repo_activity_developer_login_idx" ON "developer_repo_activity"("developer_login");

-- CreateIndex
CREATE INDEX "developer_repo_activity_repo_id_idx" ON "developer_repo_activity"("repo_id");

-- CreateIndex
CREATE UNIQUE INDEX "developer_repo_activity_developer_login_repo_id_key" ON "developer_repo_activity"("developer_login", "repo_id");

-- AddForeignKey
ALTER TABLE "developer_repo_activity" ADD CONSTRAINT "developer_repo_activity_developer_login_fkey" FOREIGN KEY ("developer_login") REFERENCES "github_developer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "developer_repo_activity" ADD CONSTRAINT "developer_repo_activity_repo_id_fkey" FOREIGN KEY ("repo_id") REFERENCES "github_repository"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "username" TEXT,
    "telegramId" DOUBLE PRECISION NOT NULL,
    "joined_at" TIMESTAMP(3),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admins" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,

    CONSTRAINT "admins_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "movies" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "file_id" TEXT NOT NULL,
    "added_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),

    CONSTRAINT "movies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "required_channels" (
    "id" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "enabled" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "required_channels_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "requests" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_telegramId_key" ON "users"("telegramId");

-- CreateIndex
CREATE UNIQUE INDEX "admins_user_id_key" ON "admins"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "movies_code_key" ON "movies"("code");

-- CreateIndex
CREATE UNIQUE INDEX "required_channels_channelId_key" ON "required_channels"("channelId");

-- CreateIndex
CREATE UNIQUE INDEX "required_channels_username_key" ON "required_channels"("username");

-- CreateIndex
CREATE INDEX "requests_user_id_idx" ON "requests"("user_id");

-- CreateIndex
CREATE INDEX "requests_code_idx" ON "requests"("code");

-- AddForeignKey
ALTER TABLE "movies" ADD CONSTRAINT "movies_added_by_fkey" FOREIGN KEY ("added_by") REFERENCES "admins"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

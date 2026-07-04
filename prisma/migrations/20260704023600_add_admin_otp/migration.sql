-- AlterTable
ALTER TABLE "AdminUser" ADD COLUMN "otpCode" TEXT,
ADD COLUMN "otpExpiresAt" TIMESTAMP(3);

-- ID documents move to private storage (keys, not URLs): earlier values pointed at public
-- files and are dropped on purpose. Listings record moderator takedowns.
-- AlterTable
ALTER TABLE "Listing" ADD COLUMN "takenDownAt" DATETIME;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Verification" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_STARTED',
    "idDocumentKey" TEXT,
    "selfieKey" TEXT,
    "submittedAt" DATETIME,
    "reviewedAt" DATETIME,
    "reviewNote" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Verification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_Verification" ("createdAt", "id", "reviewNote", "reviewedAt", "status", "submittedAt", "updatedAt", "userId") SELECT "createdAt", "id", "reviewNote", "reviewedAt", "status", "submittedAt", "updatedAt", "userId" FROM "Verification";
DROP TABLE "Verification";
ALTER TABLE "new_Verification" RENAME TO "Verification";
CREATE UNIQUE INDEX "Verification_userId_key" ON "Verification"("userId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;


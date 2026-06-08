ALTER TABLE "project" ADD COLUMN "default_assignee_id" text;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_default_assignee_id_user_id_fk" FOREIGN KEY ("default_assignee_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE cascade;

/**
 * The auth forms are built from the admin's shared form kit. It began here in
 * M2-2 and moved to components/admin in M3-3; this keeps the auth module's own
 * imports as they were.
 */
export { Field, FormAlert, PasswordField, SubmitButton, useActionForm as useAuthForm, useLeave } from "@/components/admin/form";

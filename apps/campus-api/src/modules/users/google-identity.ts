export interface GoogleIdentity {
  subject: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  displayName: string | null;
  pictureUrl: string | null;
}

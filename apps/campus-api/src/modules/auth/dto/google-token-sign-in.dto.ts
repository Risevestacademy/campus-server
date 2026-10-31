import { IsNotEmpty, IsString } from 'class-validator';

export class GoogleTokenSignInDto {
  /**
   * The id_token Google's sign-in SDK gave the app, unmodified. It must be
   * addressed to this deployment's web client or to one of its native app
   * clients.
   */
  @IsString()
  @IsNotEmpty()
  idToken: string;
}

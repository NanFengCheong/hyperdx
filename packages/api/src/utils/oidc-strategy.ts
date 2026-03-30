import { Strategy as OIDCStrategy } from 'passport-openidconnect';
import { v4 as uuidv4 } from 'uuid';

import * as config from '@/config';
import User from '@/models/user';
import Team from '@/models/team';

import logger from './logger';

export function configureOIDCStrategy(passport: any) {
  if (!config.OIDC_ENABLED) {
    logger.info('OIDC authentication is disabled (OIDC_ISSUER or OIDC_CLIENT_ID not set)');
    return;
  }

  const issuerUrl = config.OIDC_ISSUER.replace(/\/$/, '');

  passport.use(
    'oidc',
    new OIDCStrategy(
      {
        issuer: issuerUrl,
        authorizationURL: `${issuerUrl}/authorize`,
        tokenURL: `${issuerUrl.replace('/v2.0', '')}/oauth2/v2.0/token`,
        userInfoURL: `${issuerUrl.replace('/v2.0', '')}/oidc/userinfo`,
        clientID: config.OIDC_CLIENT_ID,
        clientSecret: config.OIDC_CLIENT_SECRET,
        callbackURL: config.OIDC_CALLBACK_URL,
        scope: config.OIDC_SCOPE.split(' '),
      },
      async (
        issuer: string,
        profile: any,
        done: (err: Error | null, user?: any) => void,
      ) => {
        try {
          const oidcSubject = profile.id;
          const email =
            profile.emails?.[0]?.value ||
            profile._json?.email ||
            profile._json?.preferred_username;
          const name =
            profile.displayName ||
            profile._json?.name ||
            email?.split('@')[0];

          if (!email) {
            logger.error({ profile: profile._json }, 'OIDC profile missing email');
            return done(new Error('Email not found in OIDC profile'));
          }

          // 1. Try to find by oidcSubject (already linked)
          let user = await User.findOne({ oidcSubject });

          if (!user) {
            // 2. Try to find by email (link existing account)
            user = await User.findOne({ email: email.toLowerCase() });

            if (user) {
              // Link the existing account
              user.oidcSubject = oidcSubject;
              user.oidcProvider = 'entra-id';
              await user.save();
              logger.info(
                { userId: user._id, email },
                'Linked existing user to OIDC account',
              );
            }
          }

          if (!user) {
            // 3. Auto-provision new user into the default team
            const team = await Team.findOne({});
            if (!team) {
              logger.error('No team exists. First user must register locally.');
              return done(new Error('No team exists. Please register the first user locally.'));
            }

            user = new User({
              email: email.toLowerCase(),
              name,
              team: team._id,
              accessKey: uuidv4(),
              oidcSubject,
              oidcProvider: 'entra-id',
            });
            await user.save();
            logger.info(
              { userId: user._id, email },
              'Auto-provisioned new OIDC user',
            );
          }

          return done(null, user);
        } catch (err: any) {
          logger.error({ err }, 'OIDC verify callback error');
          return done(err);
        }
      },
    ),
  );

  logger.info('OIDC authentication strategy configured');
}

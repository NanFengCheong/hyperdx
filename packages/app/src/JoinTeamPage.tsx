import { useState } from 'react';
import { useRouter } from 'next/router';
import { NextSeo } from 'next-seo';
import {
  Button,
  Notification,
  Paper,
  PasswordInput,
  Stack,
  Text,
  Title,
} from '@mantine/core';
import { IconCircleCheck, IconLock } from '@tabler/icons-react';

import { useBrandDisplayName } from './theme/ThemeProvider';
import api from './api';
import { PasswordCheck } from './PasswordCheck';

export default function JoinTeam() {
  const router = useRouter();
  const brandName = useBrandDisplayName();
  const { err, token, success } = router.query;
  const { data: authConfig } = api.useAuthConfig();
  const showOidc = authConfig?.oidcEnabled;
  const [password, setPassword] = useState('');

  const isSuccess = success === 'pending';

  if (isSuccess) {
    return (
      <div className="AuthPage">
        <NextSeo title={`Registration Successful - ${brandName}`} />
        <div className="d-flex align-items-center justify-content-center vh-100 p-2">
          <div>
            <div className="text-center mb-4">
              <h2 className="me-2 text-center">Registration Successful</h2>
            </div>
            <Paper p="xl" withBorder>
              <Stack gap="lg" align="center">
                <IconCircleCheck size={48} color="#40c057" />
                <Title order={4} className="text-center">
                  You&apos;re all set!
                </Title>
                <Text c="dimmed" className="text-center">
                  Your account has been created. A platform administrator will
                  review your access and grant permissions shortly.
                </Text>
                <Text c="dimmed" size="sm" className="text-center">
                  You will receive a notification once your access has been
                  approved.
                </Text>
                <Button
                  component="a"
                  href="/login"
                  variant="primary"
                  size="md"
                  fullWidth
                  data-test-id="go-to-login"
                >
                  Go to Login
                </Button>
              </Stack>
            </Paper>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="AuthPage">
      <NextSeo title={`Join Team - ${brandName}`} />
      <div className="d-flex align-items-center justify-content-center vh-100 p-2">
        <div>
          <div className="text-center mb-4">
            <h2 className="me-2 text-center">Join Team</h2>
          </div>
          <Paper p="xl" withBorder>
            <Stack gap="lg">
              {showOidc && (
                <div className="text-center">
                  <Button
                    component="a"
                    href={`/api/auth/oidc?invite_token=${token}`}
                    size="md"
                    variant="primary"
                    fullWidth
                    data-test-id="oidc-join"
                  >
                    Sign in with Microsoft
                  </Button>
                </div>
              )}
              {showOidc && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                  }}
                >
                  <div style={{ flex: 1, height: 1, background: '#dee2e6' }} />
                  <span style={{ color: '#868e96', fontSize: 14 }}>or</span>
                  <div style={{ flex: 1, height: 1, background: '#dee2e6' }} />
                </div>
              )}
              <form
                className="text-start"
                action={`/api/team/setup/${token}`}
                method="POST"
              >
                <Stack gap="lg">
                  <PasswordInput
                    id="password"
                    name="password"
                    size="md"
                    label="Password"
                    placeholder="Password"
                    leftSection={<IconLock size={16} />}
                    value={password}
                    onChange={e => setPassword(e.currentTarget.value)}
                    required
                  />
                  <Notification withCloseButton={false}>
                    <PasswordCheck password={password} />
                  </Notification>
                  {err != null && (
                    <Text c="red" data-test-id="auth-error-msg">
                      {err === 'invalid'
                        ? 'Password does not meet complexity requirements'
                        : err === 'authFail'
                          ? 'Failed to sign in, please try again.'
                          : 'Unknown error occurred, please try again later.'}
                    </Text>
                  )}
                  <Button
                    variant={showOidc ? 'outline' : 'primary'}
                    type="submit"
                    size="md"
                    fullWidth
                    data-test-id="submit"
                  >
                    Setup a password
                  </Button>
                </Stack>
              </form>
            </Stack>
          </Paper>
        </div>
      </div>
    </div>
  );
}

import { useRouter } from 'next/router';
import { NextSeo } from 'next-seo';
import { Button, Paper, Stack, Text, TextInput } from '@mantine/core';

import { useBrandDisplayName } from './theme/ThemeProvider';
import api from './api';

export default function JoinTeam() {
  const router = useRouter();
  const brandName = useBrandDisplayName();
  const { err, token } = router.query;
  const { data: authConfig } = api.useAuthConfig();
  const showOidc = authConfig?.oidcEnabled;

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
              <div className="text-center">
                <form
                  className="text-start"
                  action={`/api/team/setup/${token}`}
                  method="POST"
                >
                  <TextInput
                    id="password"
                    name="password"
                    type="password"
                    label="Password"
                    styles={{
                      label: {
                        fontSize: '0.875rem',
                        color: 'var(--color-text-muted)',
                        marginBottom: 4,
                      },
                    }}
                  />
                  {err != null && (
                    <Text c="red" mt="sm" data-test-id="auth-error-msg">
                      {err === 'invalid'
                        ? 'Password is invalid'
                        : err === 'authFail'
                          ? 'Failed to sign in, please try again.'
                          : 'Unknown error occurred, please try again later.'}
                    </Text>
                  )}
                  <div className="text-center mt-4">
                    <Button
                      variant={showOidc ? 'outline' : 'primary'}
                      className="px-6"
                      type="submit"
                      fullWidth
                      data-test-id="submit"
                    >
                      Setup a password
                    </Button>
                  </div>
                </form>
              </div>
            </Stack>
          </Paper>
        </div>
      </div>
    </div>
  );
}

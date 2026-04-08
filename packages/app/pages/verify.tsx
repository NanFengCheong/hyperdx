import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { NextSeo } from 'next-seo';
import {
  Button,
  Notification,
  Paper,
  PinInput,
  Stack,
  Text,
} from '@mantine/core';

import { useBrandDisplayName } from '@/theme/ThemeProvider';
import api from '@/api';
import LandingHeader from '@/LandingHeader';

export default function VerifyPage() {
  const brandName = useBrandDisplayName();
  const router = useRouter();
  const { token } = router.query;

  const verifyOtp = api.useVerifyOtp();
  const resendOtp = api.useResendOtp();

  const [error, setError] = useState<string | null>(null);
  const [attemptsRemaining, setAttemptsRemaining] = useState<number | null>(null);
  const [resendCooldown, setResendCooldown] = useState(0);
  const [lockSeconds, setLockSeconds] = useState(0);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Magic link auto-verify
  useEffect(() => {
    if (token && typeof token === 'string') {
      window.location.href = `/api/verify-magic?token=${encodeURIComponent(token)}`;
    }
  }, [token]);

  // Resend cooldown timer
  useEffect(() => {
    if (resendCooldown <= 0) return;
    timerRef.current = setInterval(() => {
      setResendCooldown((c) => {
        if (c <= 1) {
          clearInterval(timerRef.current!);
          return 0;
        }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(timerRef.current!);
  }, [resendCooldown]);

  // Lock timer
  useEffect(() => {
    if (lockSeconds <= 0) return;
    const interval = setInterval(() => {
      setLockSeconds((s) => (s <= 1 ? 0 : s - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [lockSeconds]);

  const handleVerify = useCallback(
    (code: string) => {
      if (code.length !== 6) return;
      setError(null);
      verifyOtp.mutate(
        { code },
        {
          onSuccess: () => {
            const redirect =
              window.sessionStorage.getItem('hdx-login-redirect-url') || '/search';
            window.sessionStorage.removeItem('hdx-login-redirect-url');
            router.push(redirect);
          },
          onError: async (err: any) => {
            try {
              const data = await err.response?.json();
              if (data?.error === 'locked') {
                setLockSeconds(data.retryAfterSeconds || 900);
                setError('Too many attempts. Please wait before trying again.');
              } else if (data?.error === 'invalidCode') {
                setAttemptsRemaining(data.attemptsRemaining);
                setError('Invalid code. Please try again.');
              } else if (data?.error === 'otpExpired') {
                setError('Code expired. Please request a new one.');
              } else {
                setError('Verification failed. Please try again.');
              }
            } catch {
              setError('Verification failed. Please try again.');
            }
          },
        },
      );
    },
    [verifyOtp, router],
  );

  const handleResend = useCallback(() => {
    resendOtp.mutate(undefined as void, {
      onSuccess: () => setResendCooldown(60),
      onError: () => setResendCooldown(60),
    });
  }, [resendOtp]);

  if (token) {
    return (
      <div className="d-flex justify-content-center align-items-center vh-100">
        <Text>Verifying...</Text>
      </div>
    );
  }

  return (
    <div className="AuthPage">
      <NextSeo title={`${brandName} - Verify`} />
      <LandingHeader activeKey="/verify" fixed />
      <div className="d-flex justify-content-center align-items-center vh-100">
        <div style={{ width: '26rem' }}>
          <div className="text-center mb-2 fs-5" style={{ marginTop: -30 }}>
            Check your email
          </div>
          <div className="text-center mb-2 text-muted">
            Enter the 6-digit code we sent to your email
          </div>
          <Stack gap="xl" mt="lg">
            <Paper p={34} shadow="md" radius="md">
              <Stack gap="lg" align="center">
                <PinInput
                  length={6}
                  size="lg"
                  type="number"
                  oneTimeCode
                  autoFocus
                  disabled={lockSeconds > 0}
                  onComplete={handleVerify}
                />
                {lockSeconds > 0 && (
                  <Text size="sm" c="red">
                    Locked for {Math.floor(lockSeconds / 60)}:{String(lockSeconds % 60).padStart(2, '0')}
                  </Text>
                )}
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={handleResend}
                  disabled={resendCooldown > 0 || resendOtp.isPending}
                  loading={resendOtp.isPending}
                >
                  {resendCooldown > 0
                    ? `Resend code (${resendCooldown}s)`
                    : 'Resend code'}
                </Button>
              </Stack>
            </Paper>

            {error && (
              <Notification withCloseButton={false} withBorder color="red">
                {error}
                {attemptsRemaining != null && attemptsRemaining > 0 && (
                  <Text size="xs" mt={4}>
                    {attemptsRemaining} attempt{attemptsRemaining !== 1 ? 's' : ''} remaining
                  </Text>
                )}
              </Notification>
            )}
          </Stack>
        </div>
      </div>
    </div>
  );
}

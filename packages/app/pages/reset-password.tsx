import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { NextSeo } from 'next-seo';
import { SubmitHandler, useForm, useWatch } from 'react-hook-form';
import {
  Button,
  Notification,
  Paper,
  PasswordInput,
  PinInput,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconAt, IconLock } from '@tabler/icons-react';

import api from '@/api';
import LandingHeader from '@/LandingHeader';
import { CheckOrX, PasswordCheck } from '@/PasswordCheck';
import { useBrandDisplayName } from '@/theme/ThemeProvider';

type FormData = {
  email: string;
  password: string;
  confirmPassword: string;
};

export default function ResetPasswordPage() {
  const brandName = useBrandDisplayName();
  const router = useRouter();
  const { token } = router.query;
  const resetPassword = api.useResetPassword();

  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const hasMagicToken = typeof token === 'string' && token.length > 0;

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
    control,
  } = useForm<FormData>();

  const currentPassword = useWatch({
    control,
    name: 'password',
    defaultValue: '',
  });
  const confirmPassword = useWatch({
    control,
    name: 'confirmPassword',
    defaultValue: '',
  });
  const confirmPass = () => currentPassword === confirmPassword;

  const onSubmit: SubmitHandler<FormData> = data => {
    setError(null);
    resetPassword.mutate(
      {
        email: data.email,
        code: hasMagicToken ? undefined : code || undefined,
        token: hasMagicToken ? (token as string) : undefined,
        password: data.password,
        confirmPassword: data.confirmPassword,
      },
      {
        onSuccess: () => setSuccess(true),
        onError: async (err: any) => {
          try {
            const body = await err.response?.json();
            if (body?.error === 'locked') {
              setError(
                `Too many attempts. Wait ${Math.ceil((body.retryAfterSeconds || 900) / 60)} minutes.`,
              );
            } else if (body?.error === 'invalidCode') {
              setError(
                `Invalid code. ${body.attemptsRemaining} attempts remaining.`,
              );
            } else if (body?.error === 'otpExpired') {
              setError('Code expired. Please request a new one.');
            } else if (body?.error === 'passwordTooWeak') {
              setError('Password does not meet requirements.');
            } else {
              setError('Reset failed. Please try again.');
            }
          } catch {
            setError('Reset failed. Please try again.');
          }
        },
      },
    );
  };

  if (success) {
    return (
      <div className="AuthPage">
        <NextSeo title={`${brandName} - Password Reset`} />
        <LandingHeader activeKey="/reset-password" fixed />
        <div className="d-flex justify-content-center align-items-center vh-100">
          <div style={{ width: '26rem' }}>
            <Stack gap="xl">
              <Paper p={34} shadow="md" radius="md">
                <Stack gap="md" align="center">
                  <Text size="lg" fw={600}>
                    Password reset successful
                  </Text>
                  <Button
                    component={Link}
                    href="/login"
                    variant="primary"
                    size="md"
                    fullWidth
                  >
                    Back to Login
                  </Button>
                </Stack>
              </Paper>
            </Stack>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="AuthPage">
      <NextSeo title={`${brandName} - Reset Password`} />
      <LandingHeader activeKey="/reset-password" fixed />
      <div className="d-flex justify-content-center align-items-center vh-100">
        <div style={{ width: '26rem' }}>
          <div className="text-center mb-2 fs-5" style={{ marginTop: -30 }}>
            Reset your password
          </div>
          <form onSubmit={handleSubmit(onSubmit)}>
            <Stack gap="xl" mt="lg">
              <Paper p={34} shadow="md" radius="md">
                <Stack gap="lg">
                  <TextInput
                    label="Email"
                    size="md"
                    placeholder="you@company.com"
                    type="email"
                    leftSection={<IconAt size={18} />}
                    required
                    {...register('email', { required: true })}
                  />
                  {!hasMagicToken && (
                    <>
                      <Text size="sm" fw={500}>
                        Verification Code
                      </Text>
                      <PinInput
                        length={6}
                        size="md"
                        type="number"
                        oneTimeCode
                        value={code}
                        onChange={setCode}
                      />
                    </>
                  )}
                  <PasswordInput
                    label="New Password"
                    size="md"
                    leftSection={<IconLock size={16} />}
                    required
                    placeholder="New password"
                    error={errors.password?.message}
                    {...register('password', { required: true })}
                  />
                  <PasswordInput
                    label={
                      <CheckOrX
                        handler={confirmPass}
                        password={currentPassword}
                      >
                        Confirm Password
                      </CheckOrX>
                    }
                    size="md"
                    leftSection={<IconLock size={16} />}
                    required
                    placeholder="Confirm password"
                    error={errors.confirmPassword?.message}
                    {...register('confirmPassword', { required: true })}
                  />
                  <Notification withCloseButton={false}>
                    <PasswordCheck password={currentPassword} />
                  </Notification>
                  <Button
                    type="submit"
                    variant="primary"
                    size="md"
                    fullWidth
                    disabled={!hasMagicToken && code.length !== 6}
                    loading={isSubmitting || resetPassword.isPending}
                  >
                    Reset Password
                  </Button>
                </Stack>
              </Paper>

              {error && (
                <Notification withCloseButton={false} withBorder color="red">
                  {error}
                </Notification>
              )}

              <div className="text-center fs-8">
                <Link href="/login">Back to login</Link>
              </div>
            </Stack>
          </form>
        </div>
      </div>
    </div>
  );
}

import { useState } from 'react';
import Link from 'next/link';
import { NextSeo } from 'next-seo';
import { SubmitHandler, useForm } from 'react-hook-form';
import {
  Button,
  Notification,
  Paper,
  Stack,
  Text,
  TextInput,
} from '@mantine/core';
import { IconAt } from '@tabler/icons-react';

import { useBrandDisplayName } from '@/theme/ThemeProvider';
import api from '@/api';
import LandingHeader from '@/LandingHeader';

type FormData = { email: string };

export default function ForgotPage() {
  const brandName = useBrandDisplayName();
  const forgotPassword = api.useForgotPassword();
  const [sent, setSent] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { isSubmitting },
  } = useForm<FormData>();

  const onSubmit: SubmitHandler<FormData> = (data) => {
    forgotPassword.mutate(
      { email: data.email },
      {
        onSuccess: () => setSent(true),
        onError: () => setSent(true), // always show success
      },
    );
  };

  return (
    <div className="AuthPage">
      <NextSeo title={`${brandName} - Forgot Password`} />
      <LandingHeader activeKey="/forgot" fixed />
      <div className="d-flex justify-content-center align-items-center vh-100">
        <div style={{ width: '26rem' }}>
          <div className="text-center mb-2 fs-5" style={{ marginTop: -30 }}>
            Reset your password
          </div>
          <div className="text-center mb-2 text-muted">
            Enter your email and we&apos;ll send you a reset code
          </div>
          <Stack gap="xl" mt="lg">
            <Paper p={34} shadow="md" radius="md">
              {sent ? (
                <Stack gap="md" align="center">
                  <Text size="sm" ta="center">
                    If an account exists with that email, we&apos;ve sent a
                    reset code. Check your inbox.
                  </Text>
                  <Button
                    component={Link}
                    href="/reset-password"
                    variant="primary"
                    size="md"
                    fullWidth
                  >
                    Enter Reset Code
                  </Button>
                </Stack>
              ) : (
                <form onSubmit={handleSubmit(onSubmit)}>
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
                    <Button
                      type="submit"
                      variant="primary"
                      size="md"
                      fullWidth
                      loading={isSubmitting || forgotPassword.isPending}
                    >
                      Send Reset Code
                    </Button>
                  </Stack>
                </form>
              )}
            </Paper>
            <div className="text-center fs-8">
              <Link href="/login">Back to login</Link>
            </div>
          </Stack>
        </div>
      </div>
    </div>
  );
}

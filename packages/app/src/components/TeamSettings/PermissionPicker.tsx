import { PERMISSION_CATEGORIES } from '@hyperdx/common-utils/dist/permissions';
import { Checkbox, Group, Stack, Text } from '@mantine/core';

interface PermissionPickerProps {
  value: string[];
  onChange: (permissions: string[]) => void;
  disabled?: boolean;
}

export default function PermissionPicker({
  value,
  onChange,
  disabled,
}: PermissionPickerProps) {
  const togglePermission = (permission: string) => {
    if (value.includes(permission)) {
      onChange(value.filter(p => p !== permission));
    } else {
      onChange([...value, permission]);
    }
  };

  const toggleCategory = (permissions: readonly string[]) => {
    const allSelected = permissions.every(p => value.includes(p));
    if (allSelected) {
      onChange(value.filter(p => !permissions.includes(p)));
    } else {
      const newPerms = new Set([...value, ...permissions]);
      onChange(Array.from(newPerms));
    }
  };

  return (
    <Stack gap="md">
      {PERMISSION_CATEGORIES.map(category => {
        const allSelected = category.permissions.every(p => value.includes(p));
        const someSelected =
          !allSelected && category.permissions.some(p => value.includes(p));

        return (
          <div key={category.label}>
            <Checkbox
              label={
                <Text fw={600} size="sm">
                  {category.label}
                </Text>
              }
              checked={allSelected}
              indeterminate={someSelected}
              onChange={() => toggleCategory(category.permissions)}
              disabled={disabled}
              mb={4}
            />
            <Group gap="sm" ml="lg">
              {category.permissions.map(permission => {
                const action = permission.split(':')[1];
                return (
                  <Checkbox
                    key={permission}
                    label={action}
                    size="xs"
                    checked={value.includes(permission)}
                    onChange={() => togglePermission(permission)}
                    disabled={disabled}
                  />
                );
              })}
            </Group>
          </div>
        );
      })}
    </Stack>
  );
}

param(
  [Parameter(Mandatory = $true)]
  [string]$Account
)

$ErrorActionPreference = "Stop"

if (-not ("Rldb.LsaPolicy" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Principal;

namespace Rldb {
  public static class LsaPolicy {
    [StructLayout(LayoutKind.Sequential)]
    private struct LSA_OBJECT_ATTRIBUTES {
      public int Length;
      public IntPtr RootDirectory;
      public IntPtr ObjectName;
      public uint Attributes;
      public IntPtr SecurityDescriptor;
      public IntPtr SecurityQualityOfService;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct LSA_UNICODE_STRING {
      public ushort Length;
      public ushort MaximumLength;
      public IntPtr Buffer;
    }

    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern uint LsaOpenPolicy(
      IntPtr SystemName,
      ref LSA_OBJECT_ATTRIBUTES ObjectAttributes,
      uint DesiredAccess,
      out IntPtr PolicyHandle);

    [DllImport("advapi32.dll")]
    private static extern uint LsaAddAccountRights(
      IntPtr PolicyHandle,
      IntPtr AccountSid,
      LSA_UNICODE_STRING[] UserRights,
      uint CountOfRights);

    [DllImport("advapi32.dll")]
    private static extern uint LsaNtStatusToWinError(uint Status);

    [DllImport("advapi32.dll")]
    private static extern uint LsaClose(IntPtr PolicyHandle);

    private const uint POLICY_LOOKUP_NAMES = 0x00000800;
    private const uint POLICY_CREATE_ACCOUNT = 0x00000010;

    public static void GrantLogonAsBatchJob(string accountName) {
      SecurityIdentifier sid =
        (SecurityIdentifier)new NTAccount(accountName).Translate(typeof(SecurityIdentifier));
      byte[] sidBytes = new byte[sid.BinaryLength];
      sid.GetBinaryForm(sidBytes, 0);

      LSA_OBJECT_ATTRIBUTES attributes = new LSA_OBJECT_ATTRIBUTES();
      attributes.Length = Marshal.SizeOf(typeof(LSA_OBJECT_ATTRIBUTES));

      IntPtr policyHandle;
      uint status = LsaOpenPolicy(
        IntPtr.Zero,
        ref attributes,
        POLICY_LOOKUP_NAMES | POLICY_CREATE_ACCOUNT,
        out policyHandle);
      ThrowIfFailed(status, "LsaOpenPolicy");

      GCHandle sidHandle = default(GCHandle);
      IntPtr rightBuffer = IntPtr.Zero;
      try {
        sidHandle = GCHandle.Alloc(sidBytes, GCHandleType.Pinned);
        string rightName = "SeBatchLogonRight";
        rightBuffer = Marshal.StringToHGlobalUni(rightName);
        LSA_UNICODE_STRING right = new LSA_UNICODE_STRING {
          Buffer = rightBuffer,
          Length = checked((ushort)(rightName.Length * 2)),
          MaximumLength = checked((ushort)((rightName.Length + 1) * 2))
        };

        status = LsaAddAccountRights(
          policyHandle,
          sidHandle.AddrOfPinnedObject(),
          new[] { right },
          1);
        ThrowIfFailed(status, "LsaAddAccountRights");
      } finally {
        if (rightBuffer != IntPtr.Zero) Marshal.FreeHGlobal(rightBuffer);
        if (sidHandle.IsAllocated) sidHandle.Free();
        LsaClose(policyHandle);
      }
    }

    private static void ThrowIfFailed(uint status, string operation) {
      if (status == 0) return;
      int win32Error = unchecked((int)LsaNtStatusToWinError(status));
      throw new Win32Exception(win32Error, operation + " failed");
    }
  }
}
"@
}

[Rldb.LsaPolicy]::GrantLogonAsBatchJob($Account)
Write-Host "Granted 'Log on as a batch job' to $Account."

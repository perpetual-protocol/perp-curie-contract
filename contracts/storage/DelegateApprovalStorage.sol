// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

/// @notice For future upgrades, do not change DelegateApprovalStorageV1. Create a new
/// contract which implements DelegateApprovalStorageV1 and following the naming convention
/// DelegateApprovalStorageVX.
abstract contract DelegateApprovalStorageV1 {
    // key: the hash of `trader` and `delegate`, see _getApprovalKey()
    // value: the bit value of approved actions
    mapping(bytes32 => uint8) internal _approvalMap;
}

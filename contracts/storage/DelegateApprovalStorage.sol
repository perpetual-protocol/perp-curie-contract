// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

/// @notice For future upgrades, do not change DelegateApprovalStorageV1. Create a new
/// contract which implements DelegateApprovalStorageV1 and following the naming convention
/// DelegateApprovalStorageVX.
abstract contract DelegateApprovalStorageV1 {
    // key: approvalKey, hash(delegator, delegatee)
    mapping(bytes32 => uint8) internal _approvalMap;
}

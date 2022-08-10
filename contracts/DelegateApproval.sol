// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

import { IDelegateApproval } from "./interface/IDelegateApproval.sol";
import { BlockContext } from "./base/BlockContext.sol";
import { SafeOwnable } from "./base/SafeOwnable.sol";
import { DelegateApprovalStorageV1 } from "./storage/DelegateApprovalStorage.sol";

contract DelegateApproval is IDelegateApproval, BlockContext, SafeOwnable, DelegateApprovalStorageV1 {
    //
    // CONSTANTS
    //

    /// @dev remember to update checkActions() if we add new actions
    ///      the rule for action constants is `<<`, 2^n, n starts from 0
    ///      so actions will be 1, 2, 4, 8, 16, 32, 64, 128
    uint8 internal constant _CLEARINGHOUSE_OPENPOSITION = 1; // 00000001
    uint8 internal constant _CLEARINGHOUSE_ADDLIQUIDITY = 2; // 00000010, not used for now
    uint8 internal constant _CLEARINGHOUSE_REMOVELIQUIDITY = 4; // 00000100, not used for now

    //
    // MODIFIER
    //

    /// @dev prevent user from approving/revoking non-existed actions
    ///      we only have 3 actions now, so actions cannot be greater than 7 (00000111)
    modifier checkActions(uint8 actions) {
        // DA_IA: Invalid Actions
        require(actions > 0 && actions <= 7, "DA_IA");
        _;
    }

    //
    // EXTERNAL NON-VIEW
    //

    function initialize() external initializer {
        __SafeOwnable_init();
    }

    /// @inheritdoc IDelegateApproval
    function approve(address delegate, uint8 actions) external override checkActions(actions) {
        address trader = _msgSender();
        bytes32 key = _getApprovalKey(trader, delegate);

        // Examples:
        // oldApprovedActions: 001
        // actions: 010
        // newApprovedActions: 011

        // oldApprovedActions: 010
        // actions: 110
        // newApprovedActions: 110

        // oldApprovedActions: 010
        // actions: 100
        // newApprovedActions: 110
        _approvalMap[key] = _approvalMap[key] | actions;

        emit DelegationApproved(trader, delegate, actions);
    }

    /// @inheritdoc IDelegateApproval
    function revoke(address delegate, uint8 actions) external override checkActions(actions) {
        address trader = _msgSender();
        bytes32 key = _getApprovalKey(trader, delegate);

        // oldApprovedActions: 010
        // actions: 010
        // newApprovedActions: 000

        // oldApprovedActions: 010
        // actions: 110
        // newApprovedActions: 000

        // oldApprovedActions: 010
        // actions: 100
        // newApprovedActions: 010
        _approvalMap[key] = _approvalMap[key] & (~actions);

        emit DelegationRevoked(trader, delegate, actions);
    }

    //
    // EXTERNAL VIEW
    //

    /// @inheritdoc IDelegateApproval
    function getClearingHouseOpenPositionAction() external pure override returns (uint8) {
        return _CLEARINGHOUSE_OPENPOSITION;
    }

    /// @inheritdoc IDelegateApproval
    function getClearingHouseAddLiquidityAction() external pure override returns (uint8) {
        return _CLEARINGHOUSE_ADDLIQUIDITY;
    }

    /// @inheritdoc IDelegateApproval
    function getClearingHouseRemoveLiquidityAction() external pure override returns (uint8) {
        return _CLEARINGHOUSE_REMOVELIQUIDITY;
    }

    /// @inheritdoc IDelegateApproval
    function getApprovedActions(address trader, address delegate) external view override returns (uint8) {
        bytes32 key = _getApprovalKey(trader, delegate);
        return _approvalMap[key];
    }

    /// @inheritdoc IDelegateApproval
    function hasApprovalFor(
        address trader,
        address delegate,
        uint8 actions
    ) external view override checkActions(actions) returns (bool) {
        return _hasApprovalFor(trader, delegate, actions);
    }

    /// @inheritdoc IDelegateApproval
    function canOpenPositionFor(address trader, address delegate) external view override returns (bool) {
        return _hasApprovalFor(trader, delegate, _CLEARINGHOUSE_OPENPOSITION);
    }

    /// @inheritdoc IDelegateApproval
    function canAddLiquidityFor(address trader, address delegate) external view override returns (bool) {
        return _hasApprovalFor(trader, delegate, _CLEARINGHOUSE_ADDLIQUIDITY);
    }

    /// @inheritdoc IDelegateApproval
    function canRemoveLiquidityFor(address trader, address delegate) external view override returns (bool) {
        return _hasApprovalFor(trader, delegate, _CLEARINGHOUSE_REMOVELIQUIDITY);
    }

    //
    // INTERNAL VIEW
    //

    function _getApprovalKey(address trader, address delegate) internal pure returns (bytes32) {
        return keccak256(abi.encode(trader, delegate));
    }

    function _hasApprovalFor(
        address trader,
        address delegate,
        uint8 actions
    ) internal view checkActions(actions) returns (bool) {
        bytes32 key = _getApprovalKey(trader, delegate);

        // approvedActions: 010
        // actions: 110
        // 010 & 110 = 010 != 110 => false

        // approvedActions: 000
        // actions: 010
        // 000 & 010 = 000 != 010 => false

        // approvedActions: 110
        // actions: 110
        // 110 & 110 = 110 == 110 => true
        return (_approvalMap[key] & actions) == actions;
    }
}

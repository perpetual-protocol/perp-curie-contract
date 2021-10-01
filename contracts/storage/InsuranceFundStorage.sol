// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { IInsuranceFundState } from "../interface/IInsuranceFundState.sol";

abstract contract InsuranceFundStorageV1 is IInsuranceFundState {
    // --------- IMMUTABLE ---------

    /// @inheritdoc IInsuranceFundState
    address public override token;

    // --------- ^^^^^^^^^ ---------

    address internal borrower;
}

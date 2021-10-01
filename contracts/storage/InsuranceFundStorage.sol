// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

import { IInsuranceFundStorageV1 } from "../interface/IInsuranceFundStorage.sol";

/// @notice For future upgrades, do not change InsuranceFundStorageV1. Create a new
/// contract which implements InsuranceFundStorageV1 and following the naming convention
/// InsuranceFundStorageVX.
abstract contract InsuranceFundStorageV1 is IInsuranceFundStorageV1 {
    // --------- IMMUTABLE ---------

    /// @inheritdoc IInsuranceFundStorageV1
    address public override token;

    // --------- ^^^^^^^^^ ---------

    address public borrower;
}

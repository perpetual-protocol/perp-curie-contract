// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

/// @notice For future upgrades, do not change InsuranceFundStorageV1. Create a new
/// contract which implements InsuranceFundStorageV1 and following the naming convention
/// InsuranceFundStorageVX.
abstract contract InsuranceFundStorageV1 {
    // --------- IMMUTABLE ---------

    address internal _token;

    // --------- ^^^^^^^^^ ---------

    address internal _vault;
}

abstract contract InsuranceFundStorageV2 is InsuranceFundStorageV1 {
    address internal _surplusBeneficiary;

    // decimal is the same as the settlement token
    uint256 internal _distributionThreshold;
}

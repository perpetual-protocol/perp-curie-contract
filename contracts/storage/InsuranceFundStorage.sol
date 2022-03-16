// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

/// @notice For future upgrades, do not change InsuranceFundStorageV1. Create a new
/// contract which implements InsuranceFundStorageV1 and following the naming convention
/// InsuranceFundStorageVX.
abstract contract InsuranceFundStorageV1 {
    // --------- IMMUTABLE ---------

    address internal _token;

    // --------- ^^^^^^^^^ ---------

    address internal _borrower;
}

// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

interface IVaultStorageV1 {
    function settlementToken() external returns (address);

    /// @dev cached the settlement token's decimal for gas optimization
    function decimals() external view returns (uint8);

    function totalDebt() external view returns (uint256);

    function clearingHouseConfig() external returns (address);

    function accountBalance() external returns (address);

    function insuranceFund() external returns (address);

    function exchange() external returns (address);
}

interface IVaultStorage is IVaultStorageV1 {}

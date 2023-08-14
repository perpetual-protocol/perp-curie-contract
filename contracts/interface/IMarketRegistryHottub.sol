// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

interface IMarketRegistryHottub {
    /// @notice Emitted when the hottubFeeManager is changed
    /// @param hottubFeeManager The address of the hottubFeeManager
    event HottubFeeManagerChanged(address hottubFeeManager);

    /// @notice Get Hottub Fee Manager address
    /// @return hottubFeeManager The address of the Hottub Fee Manager
    function getHottubFeeManager() external view returns (address hottubFeeManager);
}

// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

interface IMarketRegistryFeeManager {
    /// @notice Emitted when the Fee Manager is changed
    /// @param feeManager The address of the Fee Manager
    event FeeManagerChanged(address feeManager);

    /// @notice Get Fee Manager address
    /// @return feeManager The address of the Fee Manager
    function getFeeManager() external view returns (address feeManager);

    function setFeeDiscountRatio(address trader, uint24 discountRatio) external;
}

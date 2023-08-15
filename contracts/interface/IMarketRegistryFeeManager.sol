// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;
pragma abicoder v2;

interface IMarketRegistryFeeManager {
    /// @notice Emitted when the Fee Manager is changed
    /// @param account The address of the account being changed
    /// @param isFeeManager Indicate if the address is a Fee Manager
    event FeeManagerChanged(address account, bool isFeeManager);

    /// @notice Check if address is Fee Manager
    /// @return isFeeManager Indicate if the address is a Fee Manager
    function isFeeManager(address account) external view returns (bool isFeeManager);

    function setFeeDiscountRatio(address trader, uint24 discountRatio) external;
}

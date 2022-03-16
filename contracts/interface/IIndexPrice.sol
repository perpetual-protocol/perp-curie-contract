// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.7.6;

interface IIndexPrice {
    /// @notice Returns the index price of the token.
    /// @param interval The interval represents twap interval.
    /// @return indexPrice Twap price with interval
    function getIndexPrice(uint256 interval) external view returns (uint256 indexPrice);
}

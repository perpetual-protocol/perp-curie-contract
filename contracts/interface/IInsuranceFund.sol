// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

interface IInsuranceFund {
    /// @param borrower The address of the borrower
    event BorrowerChanged(address borrower);

    function borrow(uint256 amount) external;

    function getToken() external view returns (address);

    function getBorrower() external view returns (address);
}

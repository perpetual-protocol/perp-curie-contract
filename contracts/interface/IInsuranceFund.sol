// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.7.6;

interface IInsuranceFund {
    function getToken() external view returns (address);

    function borrow(uint256 amount) external;
}
